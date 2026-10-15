"""Whole-project entity claims and multi-system connection completeness.

The agent maps source entities explicitly. This module never equates matching
room numbers across buildings, infers a hidden cable, or edits native CAD/BIM.
"""
from collections import defaultdict, deque
from decimal import Decimal, DecimalException, InvalidOperation, localcontext
import json

from .core import UNITS, compare_quantity, connection, encode, normalized, now
from .construction.planning import Planning, bounded
from .construction.simulation import canonical_hash


def rule_number(value):
    number = Decimal(str(value))
    if not number.is_finite() or len(number.as_tuple().digits) > 64 or abs(number.as_tuple().exponent) > 100:
        raise ValueError("Finite bounded rule value required")
    return number


def inspect_graph(graph):
    issues = []; entities = {e["id"]: e for e in graph["entities"]}
    def issue(code, message, entity_id=None, port_id=None, mode=None, sources=None):
        item = {"code": code, "message": message, "entity_id": entity_id, "port_id": port_id, "mode": mode, "sources": sources or []}
        item["id"] = canonical_hash(item)[:20]; issues.append(item)
    scope = graph.get("scope", {})
    expected_docs = set(scope.get("expected_documents", [])); reviewed_docs = set(scope.get("reviewed_documents", []))
    expected_sections = set(scope.get("expected_disciplines", [])); reviewed_sections = set(scope.get("reviewed_disciplines", []))
    if not expected_docs or not expected_sections:
        issue("scope_unconfirmed", "Не задан полный ожидаемый состав документов и разделов проекта")
    for doc in sorted(expected_docs-reviewed_docs):
        issue("document_not_reviewed", "Документ не отмечен как разобранный: " + doc)
    for section in sorted(expected_sections-reviewed_sections):
        issue("discipline_not_reviewed", "Раздел не отмечен как разобранный: " + section)
    identity_groups = defaultdict(list)
    ports = {}
    for entity in entities.values():
        key = entity["id"]; kind = entity.get("kind", "equipment"); claims = entity.get("claims", [])
        if kind == "room":
            identity = entity.get("identity", {})
            if all(identity.get(k) is not None for k in ("building", "level", "room_number")):
                identity_groups[tuple(str(identity[k]) for k in ("building", "level", "room_number"))].append(key)
            if "required_in_disciplines" not in entity:
                issue("room_scope_unconfirmed", "Не определено, в каких разделах должно присутствовать помещение", key)
        sections = {c.get("discipline") for c in claims}
        for section in set(entity.get("required_in_disciplines", []))-sections:
            issue("entity_missing_in_discipline", "Объект не найден в обязательном разделе " + section, key)
        by_property = defaultdict(list)
        for claim in claims:
            by_property[claim["property"]].append(claim)
        for prop, values in by_property.items():
            for i, first in enumerate(values):
                for second in values[i+1:]:
                    if first.get("discipline") == second.get("discipline"):
                        continue
                    fields = ("basis", "revision_set")
                    if any(not first.get(k) or not second.get(k) or first[k] != second[k] for k in fields):
                        issue("claim_scope_difference", f"{prop}: различаются или не указаны основание и набор ревизий", key, sources=first.get("sources", [])+second.get("sources", [])); continue
                    if first.get("unit") or second.get("unit"):
                        try:
                            result = compare_quantity({**first, "entity": key, "property": prop}, {**second, "entity": key, "property": prop})
                            different = result["status"] != "matches"
                        except ValueError:
                            issue("claim_value_unconfirmed", prop + ": значение не удалось привести к конечному числу", key, sources=first.get("sources", [])+second.get("sources", [])); continue
                    else:
                        different = normalized(first.get("value")).casefold() != normalized(second.get("value")).casefold() or first.get("value") is None or second.get("value") is None
                    if different:
                        issue("cross_discipline_difference", f"{prop}: {first.get('discipline')} = {first.get('value')} {first.get('unit','')}; {second.get('discipline')} = {second.get('value')} {second.get('unit','')}", key, sources=first.get("sources", [])+second.get("sources", []))
        for requirement in entity.get("requirements", []):
            candidates = by_property.get(requirement["property"], [])
            if requirement.get("discipline"):
                candidates = [c for c in candidates if c.get("discipline") == requirement["discipline"]]
            if not candidates:
                issue("required_property_missing", "Нет данных для требования: " + requirement["id"], key, sources=requirement.get("sources")); continue
            for claim in candidates:
                if requirement.get("basis") != claim.get("basis") or not requirement.get("basis"):
                    issue("requirement_scope_unconfirmed", "Не совпадает область измерения для требования " + requirement["id"], key); continue
                rule = requirement["kind"]; failed = False
                if rule == "required_property":
                    failed = claim.get("value") is None
                elif rule == "allowed_values":
                    failed = claim.get("value") not in requirement.get("values", [])
                elif rule == "numeric_range":
                    try:
                        actual, expected = UNITS.get(claim.get("unit")), UNITS.get(requirement.get("unit"))
                        if not actual or not expected or actual[0] != expected[0]: raise ValueError()
                        with localcontext() as ctx:
                            ctx.prec = 220
                            value = rule_number(claim["value"]) * Decimal(actual[1]) / Decimal(expected[1])
                            minimum = rule_number(requirement["min"]) if requirement.get("min") is not None else None
                            maximum = rule_number(requirement["max"]) if requirement.get("max") is not None else None
                            if minimum is None and maximum is None or minimum is not None and maximum is not None and minimum > maximum: raise ValueError()
                            failed = (minimum is not None and value < minimum) or (maximum is not None and value > maximum)
                    except (DecimalException, ValueError, TypeError):
                        issue("requirement_value_unconfirmed", "Недостаточно данных или несовместимы единицы: " + requirement["id"], key); continue
                else:
                    issue("unsupported_requirement", "Не реализовано правило: " + str(rule), key); continue
                if failed:
                    issue("project_requirement_not_met", requirement["id"] + ": " + requirement["reason"], key, sources=claim.get("sources", [])+requirement.get("sources", []))
        if kind not in ("room", "level", "building") and "ports" not in entity:
            issue("connection_requirements_unconfirmed", "Для оборудования не задан перечень требуемых подключений", key)
        for port in entity.get("ports", []):
            ports[(key, port["id"])] = port
            if type(port.get("required")) is not bool:
                issue("port_requirement_unconfirmed", "Не определена обязательность подключения", key, port["id"])
    for identity, ids in identity_groups.items():
        if len(ids) > 1:
            issue("ambiguous_room_identity", f"Помещение {identity} представлено несколькими сущностями: {', '.join(ids)}")
    modes = graph.get("modes", ["normal"])
    for mode in modes:
        adjacency = defaultdict(set); degrees = defaultdict(int)
        active = lambda item: mode in item.get("modes", modes)
        for edge in graph.get("connections", []):
            if not active(edge):
                continue
            a = (edge["from"]["entity_id"], edge["from"]["port_id"])
            b = (edge["to"]["entity_id"], edge["to"]["port_id"])
            if a not in ports or b not in ports:
                issue("unknown_connection_endpoint", "Связь ссылается на неизвестный объект или порт: " + edge["id"], mode=mode); continue
            pa, pb = ports[a], ports[b]; degrees[a] += 1; degrees[b] += 1
            if not active(pa) or not active(pb):
                issue("inactive_port_connection", "Связь использует порт, отключённый в этом режиме: " + edge["id"], b[0], b[1], mode); continue
            if pa["kind"] != pb["kind"]:
                issue("incompatible_port_kind", "Несовместимые виды подключений: " + edge["id"], b[0], b[1], mode); continue
            if pa.get("direction") == "in" or pb.get("direction") == "out":
                issue("connection_direction", "Перепутано направление подключения: " + edge["id"], b[0], b[1], mode); continue
            parameters = {"electrical": ("voltage_v", "phases", "supply_type"), "water": ("medium",), "drainage": ("medium",), "automation": ("signal_type", "protocol")}.get(pa["kind"], ())
            incompatible = False
            for parameter in parameters:
                va, vb = pa.get("parameters", {}).get(parameter), pb.get("parameters", {}).get(parameter)
                equal = va == vb
                if va is not None and vb is not None and parameter in ("voltage_v", "phases"):
                    try: equal = Decimal(str(va)) == Decimal(str(vb))
                    except InvalidOperation: equal = False
                if va is not None and vb is not None and not equal:
                    issue("connection_parameter_difference", f"{edge['id']}: различается {parameter}: {va} / {vb}", b[0], b[1], mode); incompatible = True
            if not incompatible:
                adjacency[a].add(b)
                if pa.get("direction") == pb.get("direction") == "bidirectional":
                    adjacency[b].add(a)
        for entity in entities.values():
            for link in entity.get("internal_links", []):
                a, b = (entity["id"], link["from_port"]), (entity["id"], link["to_port"])
                if a not in ports or b not in ports:
                    issue("unknown_internal_port", "Внутренняя связь ссылается на неизвестный порт", entity["id"], mode=mode)
                elif ports[a]["kind"] != ports[b]["kind"]:
                    issue("incompatible_internal_kind", "Внутренняя связь объединяет разные системы", entity["id"], mode=mode)
                elif active(link) and active(ports[a]) and active(ports[b]):
                    adjacency[a].add(b)
        roots = [key for key, port in ports.items() if port.get("is_source") is True and active(port)]
        reached = set(roots); queue = deque(roots)
        while queue:
            for child in adjacency[queue.popleft()]:
                if child not in reached:
                    reached.add(child); queue.append(child)
        for key, port in ports.items():
            if not active(port):
                continue
            if port.get("required") is True and key not in reached:
                issue("required_connection_missing" if not degrees[key] else "no_path_to_source",
                      "Нет подключения" if not degrees[key] else "Нет прослеживаемой цепочки до источника", key[0], key[1], mode, entities[key[0]].get("sources"))
            if port.get("max_connections") is not None and degrees[key] > port["max_connections"]:
                issue("too_many_connections", "Число связей порта превышает заданное ограничение", key[0], key[1], mode)
    return {"issues": issues, "entity_count": len(entities), "port_count": len(ports), "issue_count": len(issues),
        "coverage": {"expected_documents": len(expected_docs), "reviewed_expected_documents": len(expected_docs & reviewed_docs), "missing_documents": sorted(expected_docs-reviewed_docs), "missing_disciplines": sorted(expected_sections-reviewed_sections),
            "claim_count": sum(len(e.get("claims", [])) for e in entities.values()), "explicit_requirement_count": sum(len(e.get("requirements", [])) for e in entities.values()),
            "checked_families": ["scope", "shared_claims", "declared_requirements", "declared_connection_paths"],
            "completeness_confirmed": False},
        "interpretation": "Проверен только переданный граф и явно заданные требования. Электрические/гидравлические расчёты и изменения CAD/BIM не выполнялись."}


class Coordination:
    def __init__(self, workspace):
        self.workspace = workspace

    def _db(self, project_id):
        path = self.workspace.db_path(project_id)
        with connection(path) as db:
            db.execute("create table if not exists coordination_graphs(revision integer primary key,payload text not null)")
            db.execute("create table if not exists coordination_audits(audit_id text primary key,payload text not null)")
            db.execute("create table if not exists coordination_requests(request_id text primary key,fingerprint text not null,result text not null)")
        return path

    def graph(self, project_id, revision=None):
        with connection(self.workspace.db_path(project_id), readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='coordination_graphs'").fetchone():
                raise ValueError("Project graph not found")
            row = db.execute("select payload from coordination_graphs where revision=?", (revision,)).fetchone() if revision else db.execute("select payload from coordination_graphs order by revision desc limit 1").fetchone()
        if not row:
            raise ValueError("Project graph not found")
        return json.loads(row[0])

    def save(self, project_id, graph, request_id, expected_revision=None, merge=False):
        if not request_id or len(request_id)>128 or len(encode(graph))>2000000:
            raise ValueError("A bounded graph and request_id of 1–128 characters are required")
        scope_supplied = "scope" in graph
        fingerprint = canonical_hash([graph,expected_revision,merge]); path = self._db(project_id)
        with connection(path, readonly=True) as db:
            retry = db.execute("select * from coordination_requests where request_id=?", (request_id,)).fetchone()
            old = db.execute("select payload from coordination_graphs order by revision desc limit 1").fetchone()
        if retry:
            if retry["fingerprint"] != fingerprint:
                raise ValueError("request_id already used with different project-graph data")
            return json.loads(retry["result"])
        previous = json.loads(old[0]) if old else None; revision = previous["revision"] if previous else 0
        if (revision and expected_revision != revision) or (not revision and expected_revision not in (None,0)):
            raise ValueError("expected_revision must match the current project graph")
        graph = json.loads(encode(graph))
        if merge:
            if not previous:
                raise ValueError("Merge requires an existing graph")
            update = {**previous, **graph}
            for field in ("entities", "connections"):
                items = {item["id"]:item for item in previous.get(field,[])}
                for item in graph.get(field,[]):
                    if item.get("remove"): items.pop(item["id"],None)
                    else: items[item["id"]]=item
                update[field]=list(items.values())
            graph=update
        entities = graph.get("entities", []); connections = graph.get("connections", [])
        if not 1 <= len(entities) <= 10000 or len(connections)>20000:
            raise ValueError("Graph must contain 1–10000 entities and <=20000 connections")
        sources=[]
        for items in (entities,connections):
            ids=[item.get("id") for item in items]
            if any(not isinstance(k,str) or not 1<=len(k)<=80 for k in ids) or len(set(ids))!=len(ids):
                raise ValueError("Entity/connection IDs must be unique strings of 1–80 characters")
            for item in items: sources.extend(item.get("sources",[]))
        for entity in entities:
            if not entity.get("name"):
                raise ValueError("Each project entity needs a name")
            ids=[p.get("id") for p in entity.get("ports",[])]
            if len(set(ids))!=len(ids) or any(not isinstance(k,str) or not k for k in ids):
                raise ValueError("Port IDs must be unique within an entity")
            for port in entity.get("ports",[]):
                if not port.get("kind") or port.get("direction") not in ("in","out","bidirectional"):
                    raise ValueError("Each port needs kind and direction in/out/bidirectional")
                if "max_connections" in port and (type(port["max_connections"]) is not int or port["max_connections"] < 1):
                    raise ValueError("max_connections must be a positive integer")
            for claim in entity.get("claims",[]):
                if not claim.get("discipline") or not claim.get("property") or "value" not in claim:
                    raise ValueError("Claims need discipline, property and value")
                sources.extend(claim.get("sources",[]))
                if not claim.get("sources") and not claim.get("assumption"):
                    raise ValueError("Claims need source pointers or an explicit assumption")
            for requirement in entity.get("requirements", []):
                if not all(requirement.get(k) for k in ("id", "kind", "property", "reason")):
                    raise ValueError("Requirements need id, kind, property and reason")
                if not requirement.get("sources") and not requirement.get("assumption"):
                    raise ValueError("Requirement criteria need sources or explicit assumptions")
                sources.extend(requirement.get("sources", []))
        for edge in connections:
            for endpoint in (edge.get("from",{}),edge.get("to",{})):
                if not endpoint.get("entity_id") or not endpoint.get("port_id"):
                    raise ValueError("Connections need from/to entity_id and port_id")
        modes=graph.get("modes",["normal"])
        if not isinstance(modes,list) or not 1<=len(modes)<=10 or any(not isinstance(m,str) for m in modes):
            raise ValueError("Choose 1–10 explicitly named operating modes")
        scope=graph.get("scope",{})
        versions={}
        for doc in set(scope.get("expected_documents",[]))|set(scope.get("reviewed_documents",[])):
            record,_ = self.workspace.source_record(project_id,doc)
            versions[doc] = {"sha256":record["sha256"],"parser_revision":record["parser_revision"]}
        # Keep the original review basis when merging an unchanged scope.
        scope["document_versions"] = scope.get("document_versions", versions) if merge and not scope_supplied else versions
        graph["scope"]=scope
        if not set(scope.get("reviewed_documents",[])) <= set(scope.get("expected_documents",[])):
            raise ValueError("Reviewed documents must belong to the expected scope")
        # Validate unique pointers together to avoid rereading the same source file per device.
        unique={encode(s):s for s in sources}
        seen=set()
        for start in range(0,len(unique),200):
            Planning(self.workspace).validate_sources(project_id,list(unique.values())[start:start+200],seen)
        graph.update(project_id=project_id,revision=revision+1,created_at=now(),connections=connections,modes=modes)
        result={"project_id":project_id,"revision":revision+1,"entities":len(entities),"connections":len(connections),"status":"unapproved_project_graph"}
        with connection(path) as db:
            db.execute("begin immediate")
            actual=db.execute("select max(revision) from coordination_graphs").fetchone()[0] or 0
            if actual!=revision: raise ValueError("Project graph changed while saving")
            db.execute("insert into coordination_graphs values (?,?)",(revision+1,encode(graph)))
            db.execute("insert into coordination_requests values (?,?,?)",(request_id,fingerprint,encode(result)))
            db.execute("insert into events(created_at,kind,payload) values (?,?,?)",(now(),"project_graph_saved",encode(result)))
        return result

    def scope_freshness(self,project_id,graph):
        changed=[]
        for doc, version in graph.get("scope",{}).get("document_versions",{}).items():
            record,_ = self.workspace.source_record(project_id,doc)
            state=self.workspace.source_state(project_id,doc,full_hash=True)
            if record["sha256"]!=version["sha256"] or record["parser_revision"]!=version["parser_revision"] or state["status"]!="content_hash_matches":
                changed.append(doc)
        return changed

    def page(self,project_id,section="entities",revision=None,offset=0,limit=40):
        graph=self.graph(project_id,revision)
        if section not in ("entities","connections"): raise ValueError("section must be entities or connections")
        return {"project_id":project_id,"revision":graph["revision"],"scope":graph.get("scope",{}),"modes":graph["modes"],"section":section,**bounded(graph[section],offset,limit)}

    def audit(self,project_id,revision=None):
        graph=self.graph(project_id,revision)
        sources=[]
        for entity in graph["entities"]:
            sources.extend(entity.get("sources",[]))
            for claim in entity.get("claims",[]): sources.extend(claim.get("sources",[]))
            for requirement in entity.get("requirements",[]): sources.extend(requirement.get("sources",[]))
        for edge in graph["connections"]: sources.extend(edge.get("sources",[]))
        unique={encode(s):s for s in sources}
        seen=set()
        for start in range(0,len(unique),200): Planning(self.workspace).validate_sources(project_id,list(unique.values())[start:start+200],seen)
        if self.scope_freshness(project_id,graph):
            raise ValueError("Reviewed document version changed; update review scope and graph before auditing")
        result={"project_id":project_id,"revision":graph["revision"],"audit_id":canonical_hash(["coordination-0.2.0",graph]),**inspect_graph(graph)}
        with connection(self._db(project_id)) as db:
            db.execute("insert or ignore into coordination_audits values (?,?)",(result["audit_id"],encode(result)))
        return {k:v for k,v in result.items() if k!="issues"}

    def findings(self,project_id,audit_id,offset=0,limit=40):
        with connection(self.workspace.db_path(project_id),readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='coordination_audits'").fetchone():
                raise ValueError("Unknown audit in selected project")
            row=db.execute("select payload from coordination_audits where audit_id=?",(audit_id,)).fetchone()
        if not row: raise ValueError("Unknown audit in selected project")
        result=json.loads(row[0]); latest=self.graph(project_id)["revision"]
        changed=self.scope_freshness(project_id,self.graph(project_id,result["revision"]))
        return {k:v for k,v in result.items() if k!="issues"}|{"graph_changed":latest!=result["revision"],"changed_documents":changed,**bounded(result["issues"],offset,limit)}

    def audits(self,project_id):
        with connection(self.workspace.db_path(project_id),readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='coordination_audits'").fetchone():
                return {"items": []}
            rows=[json.loads(r[0]) for r in db.execute("select payload from coordination_audits")]
        return {"items":[{k:v for k,v in row.items() if k!="issues"} for row in rows][-100:]}


def register_tools(mcp,workspace):
    read={"readOnlyHint":True,"idempotentHint":True}; write={"readOnlyHint":False,"destructiveHint":False,"idempotentHint":True}
    @mcp.tool(annotations=read)
    def list_project_checks() -> dict:
        """List implemented project-check families and explicit coverage limits. This is an extensible rule framework, not a declaration that every discipline has been checked."""
        return {"implemented":["document/discipline scope coverage","shared room/entity claims, units, measurement bases and revisions","ambiguous room identity and missing expected discipline","required connections and directed paths to declared sources","cabinet internal routing, operating modes and provided port-parameter compatibility","entity requirements: required_property, allowed_values, numeric_range with explicit units/basis and source or assumption"],
            "not_implemented":["automatic full drawing/model extraction","native CAD/BIM corrections","electrical/hydraulic/network sizing","geometric collision and service-clearance calculations","automatic statutory applicability/approval"],
            "extension":"Additional disciplines supply shared entities, claims, ports and requirements. Unsupported rule kinds remain explicit issues; document coverage and missing inputs stay visible."}
    @mcp.tool(annotations=read)
    def project_graph_schema() -> dict:
        """Read the whole-project coordination schema: shared rooms/equipment, discipline claims, required ports, source paths and explicit review coverage."""
        return {"entities":"Each entity needs id, name, kind (room/equipment/panel/source/etc), sources. Room identity includes building, level, room_number; mappings between disciplines must be established explicitly.",
            "claim_example":{"discipline":"AR","property":"room_area","value":"24","unit":"m2","basis":"floor_area","revision_set":"issued-1","sources":[{"fact_id":"area-fact","revision":1}]},
            "room_coverage":"required_in_disciplines is the explicitly expected discipline list for an entity; missing or differently scoped claims remain questions.",
            "requirement_example":{"id":"clear-width","kind":"numeric_range","property":"width","unit":"m","min":"1.2","basis":"clear_opening","reason":"Example only: use confirmed project criteria","assumption":"Synthetic criterion; replace with applicable source"},
            "requirements":"Entity requirements support required_property, allowed_values (values array) and numeric_range (min/max, compatible unit). Set property, basis, reason, optional discipline, sources or assumption. Unknown kinds become unsupported_requirement issues; no arbitrary executable code.",
            "port_example":{"id":"power","kind":"electrical","direction":"in","required":True,"max_connections":1,"parameters":{"voltage_v":400,"phases":3}},
            "source_ports":"Use is_source=true only on established supply/signal origins. Required ports must have a compatible directed path to such an origin, not merely a drawn link.",
            "connection_example":{"id":"feed-pump-1","from":{"entity_id":"panel-1","port_id":"out-1"},"to":{"entity_id":"pump-1","port_id":"power"}},
            "internal_links":"Explicit cabinet/panel routing: [{from_port:'incoming',to_port:'out-1'}]. Different port kinds cannot be bridged.",
            "modes":"Declare modes, e.g. ['normal','backup','fire']. Optional modes on ports/links restrict their active cases; omitted means every declared mode.",
            "scope":{"expected_documents":["REGISTERED_DOC_ID"],"reviewed_documents":[],"expected_disciplines":["AR","OV","VK","EOM","automation"],"reviewed_disciplines":[]},
            "limits":"10,000 entities; 20,000 connections; paged reads <=200. Full mode/design semantics, electrical/hydraulic sizing and CAD/BIM corrections are not automated."}
    @mcp.tool(annotations=write)
    def save_project_graph(project_id:str,graph:dict,request_id:str,expected_revision:int|None=None,merge:bool=False)->dict:
        """Save shared project entities, room/equipment claims and multi-system connections. Read project_graph_schema. Existing graphs need expected_revision; merge upserts entities/connections by id, {id,remove:true} removes. No source drawings are edited."""
        return Coordination(workspace).save(project_id,graph,request_id,expected_revision,merge)
    @mcp.tool(annotations=read)
    def get_project_graph(project_id:str,section:str="entities",revision:int|None=None,offset:int=0,limit:int=40)->dict:
        """Read bounded shared entities or connections with explicit discipline/source coverage."""
        return Coordination(workspace).page(project_id,section,revision,offset,limit)
    @mcp.tool(annotations=write)
    def audit_project_graph(project_id:str,revision:int|None=None)->dict:
        """Check cross-discipline room/entity claims and mandatory electrical/water/automation/etc port paths, modes and provided compatibility parameters. Saves an immutable audit; no automatic cables, protective-device sizing or native edits."""
        return Coordination(workspace).audit(project_id,revision)
    @mcp.tool(annotations=read)
    def get_project_issues(project_id:str,audit_id:str,offset:int=0,limit:int=40)->dict:
        """Read bounded issues, evidence pointers and coverage from a whole-project graph audit."""
        return Coordination(workspace).findings(project_id,audit_id,offset,limit)

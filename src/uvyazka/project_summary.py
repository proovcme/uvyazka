"""Literal numerical candidates over cached evidence, not accepted project facts."""
from collections import Counter
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re

from .core import connection, encode, now
from .units import ALIASES, UNITS, canonical_unit, resolve_unit

ALGORITHM = "literal-quantities-2"
SQL = """
create table if not exists quantity_pages(
 doc_id text,sha256 text,parser_revision text,page_number integer,algorithm text,
 payload text not null,primary key(doc_id,sha256,parser_revision,page_number,algorithm));
create table if not exists quantity_candidates(
 candidate_id text primary key,doc_id text,sha256 text,parser_revision text,
 page_number integer,algorithm text,group_hint text,kind text,search_text text,payload text);
create index if not exists quantity_source on quantity_candidates(doc_id,sha256,parser_revision,page_number,algorithm);
create index if not exists quantity_group on quantity_candidates(algorithm,group_hint,kind);
"""
CURRENT = "c join documents d on d.doc_id=c.doc_id and d.sha256=c.sha256 and d.parser_revision=c.parser_revision where d.index_status='text_indexed' and c.algorithm=?"
NUMBER = r"[+\-−]?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?"
NUMBER_FULL = re.compile(r"^(?P<first>"+NUMBER+r")(?:(?P<mark>\s*(?:[-–—…]|±)\s*)(?P<last>"+NUMBER+r"))?$")
symbols = set(UNITS) | set(ALIASES)
symbols.discard("1")
symbols |= {s.replace("2","²").replace("3","³") for s in list(symbols) if "2" in s or "3" in s}
UNIT_PATTERN = "(?:"+"|".join(re.escape(s).replace(r"\ ",r"[ \t\u00a0\u202f]+") for s in sorted(symbols,key=lambda s:(-len(s),s)))+")"
MEASURE = re.compile(r"(?<![\w/.,])(?P<number>"+NUMBER+r"(?:\s*(?:[-–—…]|±)\s*"+NUMBER+r")?)[ \t\u00a0\u202f]*(?P<unit>"+UNIT_PATTERN+r")(?![\w/²³])")
GROUPS = [("tep",r"площад(?:ь|и|ей|ью)|объем|объём|этаж|высот|вместим|машино.?мест"),
          ("finance",r"стоим|цен[аы]|смет|руб|бюджет"),
          ("capacity",r"мощност|расход|давлен|нагрузк|напряж|ток|тепл|воздух|водоснаб"),
          ("quantities",r"бетон|сталь|арматур|труб|кирпич|материал|объ[её]м работ")]


def number_value(raw):
    match = NUMBER_FULL.fullmatch(raw.strip())
    if not match:
        return None, "unparsed"
    if match["mark"]:
        return None, "range_or_tolerance"
    normalized = re.sub(r"[ \u00a0\u202f]", "", match["first"]).replace(",", ".").replace("−", "-")
    try:
        value = Decimal(normalized)
        if not value.is_finite() or len(value.as_tuple().digits) > 128:
            return None, "unparsed"
        return str(value), "scalar"
    except InvalidOperation:
        return None, "unparsed"


def group_hint(label):
    return next((group for group,pattern in GROUPS if re.search(pattern,label,re.I)), "other")


def extract_candidates(text, locator, limit=300):
    """Keep literal row/cell context. No assignment of quantity scope or project revision."""
    found = []; table = locator.get("kind") in {"docx_table_row","excel_row","csv_row"}
    if locator.get("kind") == "docx_table_row":
        cells = text.split(" | ")
    elif locator.get("kind") == "excel_row":
        cells = [str(c["value"]) for c in locator.get("cells",[])]
    elif locator.get("kind") == "csv_row":
        cells = locator.get("cells",[])
    else:
        cells = []
    if table:
        for i, unit_cell in enumerate(cells):
            raw_unit = str(unit_cell).strip()
            if NUMBER_FULL.fullmatch(raw_unit):
                continue
            # Unregistered literal count units are retained, never converted.
            if not resolve_unit(raw_unit) and raw_unit not in {"этаж","эт.","мест","место","чел.","чел"}:
                continue
            label = " | ".join(str(s).strip() for s in cells[:i] if str(s).strip() and not NUMBER_FULL.fullmatch(str(s).strip()))
            if not label:
                continue
            for column in range(i+1,len(cells)):
                raw = str(cells[column]).strip()
                value, number_kind = number_value(raw)
                if number_kind == "unparsed":
                    continue
                # Formula text is not an evaluated number; cached formulas remain separate evidence.
                found.append({"label":label[:600],"raw_value":raw,"raw_unit":raw_unit,"value":value,
                              "number_kind":number_kind,"kind":"table_value","column":column+1,
                              "cell":locator.get("cells",[])[column].get("cell") if locator.get("kind")=="excel_row" else None})
    else:
        for match in MEASURE.finditer(text):
            raw = match["number"]; value, number_kind = number_value(raw)
            start=max(0,match.start()-180);end=min(len(text),match.end()+180)
            line_start=text.rfind("\n",0,match.start())+1
            label=re.split(r"[;|]",text[line_start:match.start()])[-1].strip(" \t:;|–—-")
            found.append({"label":label[:600],"raw_value":raw,"raw_unit":match["unit"],"value":value,
                          "number_kind":number_kind,"kind":"inline_quantity","character_start":match.start(),
                          "character_end":match.end(),"excerpt":text[start:end]})
            if len(found)>limit:
                break
    truncated = len(found)>limit
    for item in found[:limit]:
        unit = resolve_unit(item["raw_unit"])
        item.update(unit=canonical_unit(item["raw_unit"]),dimension=unit[0] if unit else None,
                    group_hint=group_hint(item["label"]),status="automatic_candidate",
                    excerpt=item.get("excerpt",text[:1600]),locator={k:v for k,v in locator.items() if k!="cells"})
    return found[:limit], truncated


class ProjectSummary:
    def __init__(self, workspace, project_id):
        self.workspace=workspace;self.project_id=project_id;self.path=workspace.db_path(project_id)

    def index(self, page_limit=500):
        if type(page_limit) is not int or not 1<=page_limit<=2000:
            raise ValueError("page_limit must be 1–2000")
        with connection(self.path) as db:
            db.executescript(SQL)
            pending = db.execute("""select p.* from pages p join documents d on d.doc_id=p.doc_id and d.sha256=p.sha256
              and d.parser_revision=p.parser_revision where d.index_status='text_indexed' and not exists(
              select 1 from quantity_pages q where q.doc_id=p.doc_id and q.sha256=p.sha256 and q.parser_revision=p.parser_revision
              and q.page_number=p.page_number and q.algorithm=?) order by p.doc_id,p.page_number limit ?""",(ALGORITHM,page_limit)).fetchall()
        processed=0
        with connection(self.path) as db:
            db.execute("begin immediate")
            for page in pending:
                locator=json.loads(page["locator"])
                items,truncated=extract_candidates(page["text"],locator)
                source={k:page[k] for k in ("doc_id","sha256","parser_revision","page_number")}
                for n,item in enumerate(items):
                    item.update(source=source,candidate_id=hashlib.sha256(encode([ALGORITHM,source,n,item]).encode()).hexdigest())
                current=db.execute("select sha256,parser_revision,index_status from documents where doc_id=?",(page["doc_id"],)).fetchone()
                if not current or tuple(current)!=(page["sha256"],page["parser_revision"],"text_indexed"):
                    continue
                if db.execute("select 1 from quantity_pages where doc_id=? and sha256=? and parser_revision=? and page_number=? and algorithm=?",(*source.values(),ALGORITHM)).fetchone():
                    continue
                for item in items:
                    db.execute("insert or ignore into quantity_candidates values (?,?,?,?,?,?,?,?,?,?)",(item["candidate_id"],*source.values(),ALGORITHM,item["group_hint"],item["kind"],item["label"]+" "+item["excerpt"],encode(item)))
                db.execute("insert into quantity_pages values (?,?,?,?,?,?)",(*source.values(),ALGORITHM,encode({"count":len(items),"truncated":truncated,"indexed_at":now()})))
                processed+=1
        state=self.state()
        return {"project_id":self.project_id,"processed_pages":processed,**state}

    def state(self):
        result={"algorithm":ALGORITHM,"candidate_count":0,"indexed_blocks":0,"truncated_blocks":0,"by_group":{}}
        with connection(self.path,readonly=True) as db:
            total=db.execute("select count(*) from pages p join documents d on d.doc_id=p.doc_id and d.sha256=p.sha256 and d.parser_revision=p.parser_revision where d.index_status='text_indexed'").fetchone()[0]
            if db.execute("select 1 from sqlite_master where name='quantity_pages'").fetchone():
                result["indexed_blocks"]=db.execute("select count(*) from quantity_pages "+CURRENT,(ALGORITHM,)).fetchone()[0]
                result["truncated_blocks"]=db.execute("select count(*) from quantity_pages "+CURRENT+" and json_extract(c.payload,'$.truncated')=1",(ALGORITHM,)).fetchone()[0]
                result["by_group"]={r[0]:r[1] for r in db.execute("select c.group_hint,count(*) from quantity_candidates "+CURRENT+" group by c.group_hint",(ALGORITHM,))}
                result["candidate_count"]=sum(result["by_group"].values())
        result.update(total_blocks=total,remaining_blocks=max(0,total-result["indexed_blocks"]))
        return result

    def read(self, query="", group=None, offset=0, limit=30):
        offset=max(0,int(offset));limit=max(1,min(int(limit),50))
        state=self.state();items=[];highlights=[];total=0
        with connection(self.path,readonly=True) as db:
            docs=[dict(r) for r in db.execute("select relative_path,extension,index_status from documents")]
            formats=Counter(d["extension"] for d in docs);folders=Counter(d["relative_path"].split("/")[0] if "/" in d["relative_path"] else "Корень" for d in docs)
            if db.execute("select 1 from sqlite_master where name='quantity_candidates'").fetchone():
                scope=CURRENT;args=[ALGORITHM]
                if group:scope+=" and c.group_hint=?";args.append(group)
                if query:scope+=" and casefold(c.search_text) like casefold(?)";args.append("%"+str(query)[:300]+"%")
                total=db.execute("select count(*) from quantity_candidates "+scope,args).fetchone()[0]
                rows=db.execute("select c.payload,d.relative_path from quantity_candidates "+scope+" order by d.relative_path,c.page_number,c.candidate_id limit ? offset ?",(*args,limit,offset)).fetchall()
                for row in rows:items.append({**json.loads(row[0]),"relative_path":row[1]})
                rows=db.execute("select c.payload,d.relative_path from quantity_candidates "+CURRENT+" and c.kind='table_value' and c.group_hint='tep' order by d.relative_path,c.page_number limit 150",(ALGORITHM,)).fetchall()
                seen=set()
                for row in rows:
                    item=json.loads(row[0]);key=(item["label"],item["raw_value"],item["unit"])
                    if not re.match(r"^(?:Площадь|Общая площадь|Строительный объ[её]м|Этажность|Высота здания|Вместимость)\b",item["label"],re.I):
                        continue
                    if key in seen:continue
                    seen.add(key);highlights.append({**item,"relative_path":row[1]})
                    if len(highlights)>=16:break
        freshness={}
        for item in items+highlights:
            doc=item["source"]["doc_id"]
            if doc not in freshness:freshness[doc]=self.workspace.source_state(self.project_id,doc)["status"]
            item["source_freshness"]=freshness[doc]
        return {"project_id":self.project_id,"state":state,"inventory":{"formats":dict(formats),"folders":dict(folders)},
                "highlights":highlights,"items":items,"total":total,"offset":offset,"next_offset":offset+len(items) if offset+len(items)<total else None,
                "interpretation":"Literal automatic candidates, not model-reviewed observations or accepted engineering values. No implicit totals, room identity or revision acceptance."}

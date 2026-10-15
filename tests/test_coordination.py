import copy
from pathlib import Path
import tempfile
import unittest
from uvyazka.core import Workspace
from uvyazka.demo import create_demo
from uvyazka.coordination import Coordination, inspect_graph


def pump_graph():
    entities=[{"id":"source","name":"Power source","kind":"source","ports":[{"id":"feed","kind":"electrical","direction":"out","required":False,"is_source":True}]}]
    for i in range(10):
        entities.append({"id":f"pump-{i}","name":f"Pump {i}","kind":"equipment","ports":[{"id":"power","kind":"electrical","direction":"in","required":True,"max_connections":1}]})
    edges=[{"id":f"feed-{i}","from":{"entity_id":"source","port_id":"feed"},"to":{"entity_id":f"pump-{i}","port_id":"power"}} for i in range(3)]
    return {"entities":entities,"connections":edges,"modes":["normal"],"scope":{}}


class CoordinationTests(unittest.TestCase):
    def test_reviewed_source_changes_invalidate_audit_and_merge_keeps_review_basis(self):
        with tempfile.TemporaryDirectory() as td:
            ws=Workspace(Path(td)/"state");create_demo(ws);c=Coordination(ws)
            doc=ws.find_documents("demo-a")["documents"][0]
            graph=pump_graph();graph["scope"]={"expected_documents":[doc["doc_id"]],"reviewed_documents":[doc["doc_id"]],"expected_disciplines":["EOM"],"reviewed_disciplines":["EOM"]}
            c.save("demo-a",graph,"scope");audit=c.audit("demo-a")
            _,source=ws.source_record("demo-a",doc["doc_id"])
            source.write_text(source.read_text(encoding="utf-8")+"\nchanged",encoding="utf-8")
            c.save("demo-a",{"entities":[{"id":"pump-9","remove":True}]},"merge",1,True)
            self.assertEqual(c.findings("demo-a",audit["audit_id"])["changed_documents"],[doc["doc_id"]])
            with self.assertRaises(ValueError):c.audit("demo-a")

    def test_extensible_requirements_report_unknown_and_missing_inputs(self):
        graph={"entities":[{"id":"opening","kind":"building","name":"Opening","claims":[{"discipline":"AR","property":"width","value":"1100","unit":"mm","basis":"clear"}],
            "requirements":[{"id":"width","kind":"numeric_range","property":"width","unit":"m","min":"1.2","basis":"clear","reason":"Synthetic criterion"},
                            {"id":"custom","kind":"unknown_solver","property":"width","basis":"clear","reason":"Requires external tool"},
                            {"id":"missing","kind":"required_property","property":"height","basis":"clear","reason":"Missing height"}]}]}
        codes={i["code"] for i in inspect_graph(graph)["issues"]}
        self.assertTrue({"project_requirement_not_met","unsupported_requirement","required_property_missing"}<=codes)
        graph["entities"][0]["requirements"][0]["min"]="1e999999999"
        self.assertIn("requirement_value_unconfirmed",{i["code"] for i in inspect_graph(graph)["issues"]})

    def test_inactive_ports_cannot_form_a_source_path(self):
        graph=pump_graph(); graph["modes"]=["normal","fire"]
        graph["entities"][0]["ports"][0]["modes"]=["normal"]
        graph["entities"][1]["ports"][0]["parameters"]={"voltage_v":"400.0"}
        graph["entities"][0]["ports"][0]["parameters"]={"voltage_v":400}
        result=inspect_graph(graph)
        self.assertFalse(any(i["code"]=="connection_parameter_difference" for i in result["issues"]))
        self.assertTrue(any(i["code"]=="no_path_to_source" and i["entity_id"]=="pump-0" and i["mode"]=="fire" for i in result["issues"]))

    def test_ten_pumps_three_feeds_find_seven_gaps(self):
        result=inspect_graph(pump_graph())
        missing=[i for i in result["issues"] if i["code"]=="required_connection_missing"]
        self.assertEqual({i["entity_id"] for i in missing},{f"pump-{i}" for i in range(3,10)})
        self.assertTrue(any(i["code"]=="scope_unconfirmed" for i in result["issues"]))

    def test_cabinet_paths_do_not_confuse_three_incoming_feeds_with_ten_loads(self):
        graph=pump_graph();graph["connections"]=[]
        cabinet={"id":"cabinet","name":"Control cabinet","kind":"cabinet","ports":[{"id":"in","kind":"electrical","direction":"in","required":True}],"internal_links":[]}
        graph["connections"].append({"id":"incoming","from":{"entity_id":"source","port_id":"feed"},"to":{"entity_id":"cabinet","port_id":"in"}})
        for i in range(10):
            cabinet["ports"].append({"id":f"out-{i}","kind":"electrical","direction":"out","required":False})
            cabinet["internal_links"].append({"from_port":"in","to_port":f"out-{i}"})
            graph["connections"].append({"id":f"load-{i}","from":{"entity_id":"cabinet","port_id":f"out-{i}"},"to":{"entity_id":f"pump-{i}","port_id":"power"}})
        graph["entities"].append(cabinet)
        self.assertFalse(any(i["code"] in ("required_connection_missing","no_path_to_source") for i in inspect_graph(graph)["issues"]))
        graph["connections"].pop(0)
        self.assertEqual(sum(i["code"]=="no_path_to_source" for i in inspect_graph(graph)["issues"]),10)

    def test_modes_and_compatibility_are_checked(self):
        graph=pump_graph();graph["modes"]=["normal","fire"];graph["connections"][0]["modes"]=["normal"]
        source=graph["entities"][0]["ports"][0];source["parameters"]={"voltage_v":400}
        graph["entities"][2]["ports"][0]["parameters"]={"voltage_v":230}
        result=inspect_graph(graph)
        self.assertTrue(any(i["entity_id"]=="pump-0" and i["mode"]=="fire" and i["code"]=="required_connection_missing" for i in result["issues"]))
        self.assertTrue(any(i["code"]=="connection_parameter_difference" for i in result["issues"]))

    def test_room_explications_compare_units_scope_and_section_presence(self):
        claims=[{"discipline":"AR","property":"room_area","value":"20","unit":"m2","basis":"floor","revision_set":"1"},
                {"discipline":"OV","property":"room_area","value":".002","unit":"ha","basis":"floor","revision_set":"1"}]
        room={"id":"b1-l1-r1","name":"Room 1","kind":"room","identity":{"building":"b1","level":"l1","room_number":"1"},"required_in_disciplines":["AR","OV","EOM"],"claims":claims}
        graph={"entities":[room],"connections":[]}
        result=inspect_graph(graph)
        self.assertFalse(any(i["code"]=="cross_discipline_difference" for i in result["issues"]))
        self.assertTrue(any(i["code"]=="entity_missing_in_discipline" for i in result["issues"]))
        claims[1]["value"]=".003"
        self.assertTrue(any(i["code"]=="cross_discipline_difference" for i in inspect_graph(graph)["issues"]))
        claims[1]["basis"]="served_zone"
        self.assertTrue(any(i["code"]=="claim_scope_difference" for i in inspect_graph(graph)["issues"]))

    def test_graph_revisions_isolation_audit_and_retry(self):
        with tempfile.TemporaryDirectory() as td:
            ws=Workspace(Path(td)/"state");create_demo(ws); c=Coordination(ws);graph=pump_graph();original=copy.deepcopy(graph)
            first=c.save("demo-a",graph,"graph");self.assertEqual(first,c.save("demo-a",graph,"graph"));self.assertEqual(original,graph)
            audit=c.audit("demo-a");self.assertEqual(c.findings("demo-a",audit["audit_id"],limit=1)["next_offset"],1)
            with self.assertRaises(ValueError):c.findings("demo-b",audit["audit_id"])
            c.save("demo-a",{"entities":[{"id":"pump-9","remove":True}]},"merge",1,True)
            self.assertTrue(c.findings("demo-a",audit["audit_id"])["graph_changed"])
            self.assertEqual(len(c.graph("demo-a",1)["entities"]),11)
            with self.assertRaises(ValueError):c.save("demo-a",graph,"stale",1)

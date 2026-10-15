import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from uvyazka.core import Workspace
from uvyazka.demo import create_demo
from uvyazka.ingest import scan
from uvyazka.construction.planning import Planning, duration_from_quantity
from uvyazka.construction.simulation import SimulationEngine


def sample_scenario(model_id=None):
    return {"id":"works","name":"Synthetic works","model_id":model_id,"resources":[{"id":"crew","name":"Crew","capacity":1}],
        "assumptions":["Synthetic durations"],"operations":[{"id":key,"name":key,"kind":"assembly","duration":10,"demands":{"crew":1},"dependencies":[],
          "target_ids":["slab"] if model_id else [],"evidence":{"kind":"assumed","reason":"Synthetic input"}} for key in ("a","b")]}


class ConstructionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.ws=Workspace(Path(self.temp.name)/"state"); create_demo(self.ws); self.p=Planning(self.ws)

    def test_resource_wait_cpm_alternatives_and_immutable_inputs(self):
        source=sample_scenario(); before=copy.deepcopy(source)
        self.p.save_scenario("demo-a",source,"save")
        one=self.p.run_scenario("demo-a","works"); two=self.p.run_scenario("demo-a","works",resource_overrides={"crew":2})
        self.assertEqual((one["duration_minutes"],two["duration_minutes"]),(20,10))
        self.assertEqual(one["dependency_duration_minutes"],10)
        self.assertEqual(source,before)
        self.assertEqual(self.p.scenario("demo-a","works")["resources"][0]["capacity"],1)
        self.assertEqual(one,self.p.run_scenario("demo-a","works"))
        self.assertTrue(any(e["kind"]=="resource_wait" for e in self.p.run("demo-a",one["run_id"])["events"]))
        with self.assertRaises(ValueError): self.p.run("demo-b",one["run_id"])
        page=self.p.run_page("demo-a",one["run_id"],offset=0,limit=1)
        self.assertEqual(page["next_offset"],1)

    def test_revision_merge_and_idempotent_retry(self):
        source=sample_scenario(); first=self.p.save_scenario("demo-a",source,"save")
        self.assertEqual(first,self.p.save_scenario("demo-a",source,"save"))
        patch={"id":"works","operations":[{**source["operations"][0],"duration":15}]}
        second=self.p.save_scenario("demo-a",patch,"patch",1,True)
        self.assertEqual(second["revision"],2)
        self.assertEqual(len(self.p.scenario("demo-a","works")["operations"]),2)
        self.assertEqual(self.p.scenario("demo-a","works",1)["operations"][0]["duration"],10)
        with self.assertRaises(ValueError): self.p.save_scenario("demo-a",patch,"stale",1,True)

    def test_cycles_bad_demands_unknown_targets_and_no_silent_repair(self):
        for changed in ("cycle","resource","target","boolean"):
            source=sample_scenario()
            if changed=="cycle": source["operations"][0]["dependencies"]=["b"]; source["operations"][1]["dependencies"]=["a"]
            if changed=="resource": source["operations"][0]["demands"]={"crew":2}
            if changed=="target": source["operations"][0]["target_ids"]=["another-project-element"]
            if changed=="boolean": source["operations"][0]["duration"]=True
            with self.assertRaises(ValueError,msg=changed): self.p.save_scenario("demo-a",source,changed)
        self.assertEqual(self.p.list_scenarios("demo-a")["total"],0)

    def test_productivity_units_and_rounding(self):
        calc={"quantity":".2","quantity_unit":"100 m3","production_per_hour":"3","production_unit":"m3"}
        self.assertEqual(duration_from_quantity(calc),400)
        self.assertEqual(duration_from_quantity({**calc,"quantity":".2001"}),401)
        for value in ("NaN","Infinity","-1","0","1e99999"):
            with self.assertRaises(ValueError): duration_from_quantity({**calc,"quantity":value})
        with self.assertRaises(ValueError): duration_from_quantity({**calc,"production_unit":"kg"})

    def test_document_boxes_with_fingerprints_and_stale_source_rejection(self):
        fact=self.ws.get_evidence_chain("demo-a","area-design")["fact"]
        source=fact["sources"][0]
        model=self.p.save_model("demo-a","Document-derived model",[{"id":"slab","name":"Slab","bbox_min_m":[0,0,0],"bbox_max_m":[4,6,.2],"geometry_basis":"Synthetic scale example"}],"model",[source],["Approximate envelope"])
        binary=(self.p.model_path("demo-a",model["model_id"])/"geometry.bin").read_bytes()
        self.assertEqual(len(binary),8*3*4+36*4)
        self.p.save_scenario("demo-a",sample_scenario(model["model_id"]),"works")
        with self.assertRaises(ValueError): self.p.model("demo-b",model["model_id"])
        _,path=self.ws.source_record("demo-a",source["doc_id"]);path.write_text("Changed",encoding="utf-8")
        with self.assertRaises(ValueError): self.p.run_scenario("demo-a","works")

    def test_snapshot_and_different_virtual_steps_reproduce_the_same_run(self):
        s=sample_scenario();s["model_id"]="synthetic"; expected=SimulationEngine(s).run()
        engine=SimulationEngine(s);engine.advance_to(7);snapshot=json.loads(json.dumps(engine.snapshot()))
        self.assertEqual(SimulationEngine.restore(s,snapshot).run(),expected)
        slow=SimulationEngine(s)
        for tick in range(21): slow.advance_to(tick)
        self.assertEqual(slow.events,expected["events"])

    @unittest.skipUnless(importlib.util.find_spec("ifcopenshell"),"Optional IFC extra not installed")
    def test_native_ifc_import_uses_a_generated_model(self):
        import ifcopenshell.api
        f=ifcopenshell.api.run("project.create_file",version="IFC4")
        ifcopenshell.api.run("root.create_entity",f,ifc_class="IfcProject",name="Synthetic")
        unit=ifcopenshell.api.run("unit.add_si_unit",f,unit_type="LENGTHUNIT")
        ifcopenshell.api.run("unit.assign_unit",f,units=[unit])
        context=ifcopenshell.api.run("context.add_context",f,context_type="Model")
        body=ifcopenshell.api.run("context.add_context",f,context_type="Model",context_identifier="Body",target_view="MODEL_VIEW",parent=context)
        wall=ifcopenshell.api.run("root.create_entity",f,ifc_class="IfcWall",name="Generated test wall")
        rep=ifcopenshell.api.run("geometry.add_wall_representation",f,context=body,length=4,height=3,thickness=.2)
        ifcopenshell.api.run("geometry.assign_representation",f,product=wall,representation=rep)
        root=Path(self.ws.project("demo-a")["source_root"]); path=root/"generated.ifc";f.write(str(path));before=path.read_bytes()
        scan(self.ws,"demo-a"); doc=self.ws.find_documents("demo-a","generated.ifc")["documents"][0]
        imported=self.p.import_ifc("demo-a",doc["doc_id"],"ifc")
        self.assertEqual(imported["statistics"]["physical_elements"],1)
        self.assertEqual(path.read_bytes(),before)
        self.p.suggest_ifc_scenario("demo-a",imported["model_id"],"ifc-plan","suggest")
        self.assertEqual(self.p.run_scenario("demo-a","ifc-plan")["status"],"completed")

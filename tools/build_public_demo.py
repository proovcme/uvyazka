"""Export a completely synthetic federated model and IFCCS runs for static hosting."""
from pathlib import Path
import argparse
import csv
import json

from uvyazka.construction.geometry import box_model
from uvyazka.construction.federation import create_federation
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.planning import cpm
from uvyazka.construction.quantities import quantity
from uvyazka.construction.simulation import SimulationEngine


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,allow_nan=False),encoding="utf-8")


def synthetic_part(cache,name,boxes):
    elements=[{"id":str(i),"name":title,"class":cls,"materials":[material],"bbox_min_m":low,"bbox_max_m":high,
        "storey_id":"Первый этаж" if low[2]<3.8 else "Второй этаж", "geometry_basis":"Completely synthetic geometry in metres; no project documents"}
        for i,(title,cls,material,low,high) in enumerate(boxes,1)]
    model,binary=box_model(name,elements,[],["Синтетическая учебная модель, все размеры вымышлены"])
    model["source"]["schema"]="SyntheticDemo"
    for e in model["elements"]:
        e["hierarchy"].extend((["IfcFlowSegment"] if e["class"]=="IfcDuctSegment" else ["IfcFlowTerminal"] if e["class"]=="IfcAirTerminal" else [])+["IfcElement"]);e["quantities"]={}
        a,b=e["mesh"]["bbox_min_m"],e["mesh"]["bbox_max_m"]
        x,y,z=[b[i]-a[i] for i in range(3)]
        e["measured_quantities"]={k:quantity(v,u,"derived","synthetic_box_fixture") for k,v,u in [
            ("volume",x*y*z,"m3"),("plan_area",x*y,"m2"),("side_area",max(x,y)*z,"m2"),
            ("length",max(x,y,z),"m"),("form_sides",2*(x+y)*z,"m2"),("form_soffit",x*y,"m2")]}
        if e["class"]=="IfcSlab": e["predefined_type"]="FLOOR"
        e["property_sets"]={"Pset_WallCommon":{"IsExternal":True,"LoadBearing":True}} if e["class"]=="IfcWall" else {}
    root=cache/"models"/model["model_id"];root.mkdir(parents=True,exist_ok=True)
    write(root/"manifest.json",model);(root/"geometry.bin").write_bytes(binary)
    return model["model_id"]


def export(destination, cache=None):
    cache=cache or destination.parent/"synthetic-cache"
    structure=[("Фундамент","IfcFooting","Concrete - Cast In Situ",[0,0,-.45],[10,7,0]),
               ("Пол первого этажа","IfcSlab","Concrete - Cast In Situ",[0,0,0],[10,7,.18]),
               ("Перекрытие","IfcSlab","Concrete - Cast In Situ",[0,0,3.5],[10,7,3.7]),
               ("Кровля","IfcRoof","Steel",[0,0,7],[10,7,7.15])]
    for level in [0,3.7]:
        for x,y in [(0,0),(9.6,0),(0,6.6),(9.6,6.6)]:
            structure.append(("Колонна","IfcColumn","Steel",[x,y,level+.18],[x+.4,y+.4,level+3.5]))
        structure.append(("Наружная стена","IfcWall","Masonry",[0,0,level+.18],[10,.25,level+3.5]))
    engineering=[]
    for level in [0,3.7]:
        for y in [2,4.5]:
            engineering.extend([("Воздуховод","IfcDuctSegment","Steel",[1,y,level+2.8],[8,y+.3,level+3.1]),
                ("Решётка","IfcAirTerminal","Steel",[7.4,y-.1,level+2.6],[8,y+.4,level+2.8])])
    ids=[synthetic_part(cache,"Учебная архитектура",structure),synthetic_part(cache,"Учебная вентиляция",engineering)]
    result=create_federation(cache,[{"model_id":mid,"instance_id":key,"label":label} for mid,key,label in zip(ids,["ar","ov"],["АР · учебный каркас","ОВ · учебная сеть"])])
    root=cache/"models"/result["model_id"];model=json.loads((root/"manifest.json").read_text(encoding="utf-8"))
    model["project_id"]="demo-a";model["source"]["filename"]="Учебное здание · АР + ОВ"
    destination.mkdir(parents=True,exist_ok=True)
    write(destination/("model-"+model["model_id"]+".json"),model)
    (destination/("geometry-"+model["model_id"]+".bin")).write_bytes((root/"geometry.bin").read_bytes())
    runs=[]
    for variant in ["base","reinforced"]:
        scenario=build_scenario(model,variant);scenario.update(project_id="demo-a",revision=1)
        scenario["name"]="Учебный объект · "+("базовые ресурсы" if variant=="base" else "усиленные ресурсы")
        run=SimulationEngine(scenario).run();run.update(project_id="demo-a",cpm=cpm(scenario))
        write(destination/("run-"+run["run_id"]+".json"),run)
        runs.append({"run_id":run["run_id"],"name":scenario["name"],"scenario_id":scenario["id"],"scenario_revision":1,"duration_minutes":run["duration"]})
        with (destination/("schedule-"+run["run_id"]+".csv")).open("w",encoding="utf-8-sig",newline="") as f:
            writer=csv.writer(f);writer.writerow(["Работа","Начало, мин","Конец, мин","Длительность, мин"])
            for op in scenario["operations"]:
                state=run["operation_states"][op["id"]];writer.writerow([op["name"],state["start"],state["finish"],op["duration"]])
    write(destination/"models.json",{"items":[{"model_id":model["model_id"],"name":model["source"]["filename"]}]})
    write(destination/"runs.json",{"items":runs})
    write(destination/"projects.json",{"projects":[{"id":"demo-a","name":"Учебное здание · АР + ОВ"}],"default_project":"demo-a"})
    print(json.dumps({"model_id":model["model_id"],"elements":len(model["elements"]),"runs":runs},ensure_ascii=False))


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("destination",type=Path)
    export(parser.parse_args().destination.resolve())

"""Synthetic work graph, boxes and coordination issues; no real building data."""
from .planning import Planning
from ..coordination import Coordination


def create_engineering_demo(workspace):
    p = Planning(workspace)
    project = "demo-a"
    if not p.list_models(project)["items"]:
        elements = []
        boxes = [("base", "Фундамент", [0,0,0], [8,6,.4]),
                 ("slab", "Перекрытие", [0,0,3.4], [8,6,3.65])]
        for i,(x,y) in enumerate([(0,0),(7.6,0),(0,5.6),(7.6,5.6)]):
            boxes.append((f"column-{i}", f"Колонна {i+1}", [x,y,.4], [x+.4,y+.4,3.4]))
        for key,name,low,high in boxes:
            elements.append({"id":key,"name":name,"bbox_min_m":low,"bbox_max_m":high,
                "geometry_basis":"Синтетические размеры, метры; условное начало [0,0,0]. Не данные учебного project.txt."})
        model = p.save_model(project,"Учебный каркас",elements,"demo-boxes-02", assumptions=["Полностью вымышленная геометрия; не восстановление из документа."])
    else:
        model = p.list_models(project)["items"][0]
    if not p.list_scenarios(project)["items"]:
        ops = []
        definitions = [("base", "Устройство фундамента", 120, [], ["base"], {"crew":1}),
                       ("hold", "Условная технологическая выдержка", 180, ["base"], [], {}),
                       ("west", "Монтаж колонн западной части", 90, ["hold"], ["column-0","column-2"], {"crew":1,"crane":1}),
                       ("east", "Монтаж колонн восточной части", 90, ["hold"], ["column-1","column-3"], {"crew":1,"crane":1}),
                       ("slab", "Монтаж перекрытия", 120, ["west","east"], ["slab"], {"crew":1,"crane":1})]
        for key,name,duration,dependencies,targets,demands in definitions:
            ops.append({"id":key,"name":name,"duration":duration,"dependencies":dependencies,"target_ids":targets,"demands":demands,
                        "evidence":{"kind":"assumed","reason":"Учебная длительность; не норматив и не расчёт реального объекта."}})
        p.save_scenario(project,{"id":"demo-frame","name":"Учебный каркас","model_id":model["model_id"],
            "resources":[{"id":"crew","name":"Бригада","capacity":1},{"id":"crane","name":"Кран","capacity":1}],
            "operations":ops,"assumptions":["Все работы и длительности вымышлены.","Непрерывные виртуальные минуты, без смен, погоды и поставок."]},"demo-scenario-02")
        p.run_scenario(project,"demo-frame")
        p.run_scenario(project,"demo-frame",resource_overrides={"crew":2,"crane":2})
    c = Coordination(workspace)
    try:
        c.graph(project)
    except ValueError:
        docs = [d["doc_id"] for d in workspace.find_documents(project)["documents"]]
        entities = [{"id":"source","name":"Учебный источник","kind":"source","ports":[{"id":"out","kind":"electrical","direction":"out","required":False,"is_source":True}]}]
        edges = []
        for i in range(1,11):
            entities.append({"id":f"pump-{i}","name":f"Учебный насос {i}","kind":"equipment","ports":[{"id":"power","kind":"electrical","direction":"in","required":True}]})
            if i<=3: edges.append({"id":f"feed-{i}","from":{"entity_id":"source","port_id":"out"},"to":{"entity_id":f"pump-{i}","port_id":"power"}})
        entities.append({"id":"room-101","kind":"room","name":"Учебное помещение 101","identity":{"building":"A","level":"1","room_number":"101"},
            "required_in_disciplines":["AR","OV","EOM"],"claims":[{"discipline":section,"property":"room_area","value":value,"unit":"m2","basis":"floor","revision_set":"synthetic-1","assumption":"Вымышленная экспликация для проверки интерфейса"} for section,value in [("AR","24"),("OV","26")]]})
        c.save(project,{"entities":entities,"connections":edges,"scope":{"expected_documents":docs,"reviewed_documents":docs,"expected_disciplines":["AR","OV","VK","EOM","automation"],"reviewed_disciplines":["AR","OV"]}},"demo-coordination-02")
        c.audit(project)

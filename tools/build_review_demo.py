"""Exact analytical cuboids with deliberately seeded overlaps and a 50 mm gap."""
from pathlib import Path
import json
from uvyazka.construction.geometry import box_model


def export(destination):
    entries=[('wall','Учебная стена','IfcWall',[0,0,0],[.3,5,3]),
             ('duct','Воздуховод через стену','IfcDuctSegment',[-2,2,2],[2,2.4,2.4]),
             ('unit','Габарит оборудования · зазор 50 мм','IfcUnitaryEquipment',[.35,3,0],[1.35,4,1]),
             ('nested','Вложенный учебный элемент','IfcBuildingElementProxy',[.05,.5,.5],[.25,1,1])]
    elements=[{'id':key,'name':name,'class':cls,'bbox_min_m':low,'bbox_max_m':high,'geometry_basis':'Exact analytical cuboid, synthetic regression fixture'} for key,name,cls,low,high in entries]
    model,binary=box_model('Синтетический стенд · коллизии и зазоры',elements,[],['Все размеры и элементы вымышлены. Формы — точные прямоугольные тела, а не габариты реального проекта.'])
    for element in model['elements']:
        element['mesh']['source']['method']='analytical_synthetic_solid'
        element['revit']={'element_id':None,'id_basis':'not_a_revit_source'}
    model['project_id']='demo-a';mid=model['model_id']
    (destination/f'model-{mid}.json').write_text(json.dumps(model,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    (destination/f'geometry-{mid}.bin').write_bytes(binary)
    for filename,row in [('models.json',{'model_id':mid,'name':model['source']['filename']}),('examples.json',{'id':mid,'kind':'model','name':model['source']['filename']})]:
        target=destination/filename;value=json.loads(target.read_text(encoding='utf-8'))
        value['items']=[x for x in value['items'] if x.get('id',x.get('model_id'))!=mid]+[row]
        target.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
    return mid


if __name__=='__main__':
    import sys
    print(export(Path(sys.argv[1])))

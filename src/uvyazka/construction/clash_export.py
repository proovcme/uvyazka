"""BCF 2.1/3.0 and formula-safe OOXML issue exports, without Office dependencies."""
from __future__ import annotations

import base64
import io
import json
import math
import re
import zipfile
from uuid import UUID, uuid5, NAMESPACE_URL
from xml.etree import ElementTree as X

from .clash_geometry import add, sub, mul, dot, length, unit


def text(value):
    value=str(value)
    if re.search('[\x00-\x08\x0b\x0c\x0e-\x1f]',value):raise ValueError('Text contains XML control characters; use JSON export')
    return value


def child(parent,tag,value=None,**attrs):
    node=X.SubElement(parent,tag,{k:text(v) for k,v in attrs.items()})
    if value is not None:node.text=text(value)
    return node


def xml(root):return X.tostring(root,encoding='utf-8',xml_declaration=True)


def camera_world(view,origin):
    """Three.js local Y-up -> BCF SI world Z-up, including clip-plane offsets."""
    rotate=lambda p:(p[0],-p[2],p[1])
    v=view['state']['view'];eye=add(rotate(v['position']),origin);target=add(rotate(v['target']),origin)
    if length(sub(target,eye))<1e-8 or length(v['up'])<1e-8:raise ValueError('Invalid saved camera')
    planes=[]
    for plane in v['planes']:
        n=plane['normal'];den=dot(n,n)
        if den<1e-16:raise ValueError('Invalid clipping plane')
        planes.append({'location':add(rotate(mul(n,-plane['constant']/den)),origin),'direction':unit(rotate(n))})
    projection=view.get('projection',{})
    return {'eye':eye,'direction':unit(sub(target,eye)),'up':unit(rotate(v['up'])),'planes':planes,
            'aspect':projection.get('aspect',1),'vertical_fov':projection.get('vertical_fov',40),'saved_projection':bool(projection)}


def vector(parent,name,p):
    if len(p)!=3 or any(not math.isfinite(x) for x in p):raise ValueError('Finite BCF vector required')
    node=child(parent,name)
    for key,value in zip(('X','Y','Z'),p):child(node,key,format(value,'.15g'))


def component(parent,ref):
    # GUIDs are never manufactured from ElementId or a geometry-fragment index.
    guid=ref.get('ifc_guid');native=ref.get('unique_id') or ref.get('revit_id')
    if not (isinstance(guid,str) and re.fullmatch(r'[0-9A-Za-z_$]{22}',guid)):guid=None
    if not guid and not native:return
    node=child(parent,'Component',**({'IfcGuid':guid} if guid else {}))
    child(node,'OriginatingSystem','Autodesk Revit' if native else 'IFC')
    if native:child(node,'AuthoringToolId',native)


def bcf(report,views=None,version='3.0'):
    if version not in {'2.1','3.0'}:raise ValueError('BCF 2.1 or 3.0 required')
    if len(report.get('issues',[]))>10000:raise ValueError('BCF issue budget exceeded')
    views=views or {};output=io.BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        root=X.Element('Version',VersionId=version);z.writestr('bcf.version',xml(root))
        for issue in report['issues']:
            guid=str(uuid5(NAMESPACE_URL,'uvyazka:issue:'+issue['id']));vguid=str(uuid5(NAMESPACE_URL,'uvyazka:view:'+issue['id']+':'+report['rule_hash']+':'+report['geometry_sha256']))
            markup=X.Element('Markup')
            header=child(markup,'Header');files=child(header,'Files') if version=='3.0' else header
            file=child(files,'File',**({'isExternal':'true'} if version=='2.1' else {}));child(file,'Filename',report.get('source_filename','ModelPackage'))
            topic=child(markup,'Topic',Guid=guid,TopicType='Clash',TopicStatus='Closed' if issue.get('status')=='resolved' else 'Open')
            child(topic,'Title',report['rule']['name']+' · '+issue['a']['name']+' / '+issue['b']['name'])
            child(topic,'CreationDate',report['created_at']);child(topic,'CreationAuthor','Uvyazka')
            description={'kind':issue['kind'],'status':issue.get('status','new'),'evidence':issue['evidence'],'source_sha256':report['source_sha256'],
                'geometry_sha256':report['geometry_sha256'],'rule_hash':report['rule_hash'],'complete':report['complete'],'reason':issue.get('reason'),'elements':[issue['a'],issue['b']]}
            child(topic,'Description',json.dumps(description,ensure_ascii=False))
            point=issue['evidence'].get('point_m',[0,0,0]);view=views.get(issue['id'])
            if view:camera=camera_world(view,report.get('render_origin_m',[0,0,0]))
            else:camera={'eye':add(point,(5,-5,4)),'direction':unit((-5,5,-4)),'up':(0,0,1),'planes':[],'aspect':1,'saved_projection':False}
            info=X.Element('VisualizationInfo',Guid=vguid)
            components=child(info,'Components');selection=child(components,'Selection')
            for ref in (issue['a'],issue['b']):component(selection,ref)
            if not list(selection):components.remove(selection)
            visibility=child(components,'Visibility',DefaultVisibility='true')
            # A saved issue snapshot isolates its pair. Never invent identities for
            # unread objects in the large scene's hidden list.
            if view and view.get('isolate_pair'):
                visibility.set('DefaultVisibility','false');exceptions=child(visibility,'Exceptions')
                for ref in (issue['a'],issue['b']):component(exceptions,ref)
                if not list(exceptions):visibility.set('DefaultVisibility','true');visibility.remove(exceptions)
            cam=child(info,'PerspectiveCamera' if camera['saved_projection'] else 'OrthogonalCamera')
            vector(cam,'CameraViewPoint',camera['eye']);vector(cam,'CameraDirection',camera['direction']);vector(cam,'CameraUpVector',camera['up'])
            aspect=camera['aspect']
            if type(aspect) not in (int,float) or not math.isfinite(aspect) or not .01<aspect<100:raise ValueError('Invalid camera aspect ratio')
            if camera['saved_projection']:
                fov=camera['vertical_fov']
                if type(fov) not in (int,float) or not 0<fov<179:raise ValueError('Invalid camera field of view')
                horizontal=math.degrees(2*math.atan(math.tan(math.radians(fov)/2)*aspect))
                if version=='2.1' and not 45<=horizontal<=60:raise ValueError('Saved camera FOV is outside BCF 2.1 schema; export BCF 3.0 to preserve it')
                child(cam,'FieldOfView',horizontal)
            else:child(cam,'ViewToWorldScale',10)
            if version=='3.0':child(cam,'AspectRatio',aspect)
            if camera['planes']:
                planes=child(info,'ClippingPlanes')
                for p in camera['planes']:
                    plane=child(planes,'ClippingPlane');vector(plane,'Location',p['location']);vector(plane,'Direction',p['direction'])
            vp=child(child(topic,'Viewpoints'),'ViewPoint',Guid=vguid) if version=='3.0' else child(markup,'Viewpoints',Guid=vguid)
            child(vp,'Viewpoint','viewpoint.bcfv')
            if view and view.get('snapshot'):
                raw=base64.b64decode(view['snapshot'],validate=True)
                if len(raw)>4*1024**2 or not raw.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('Bounded PNG snapshot required')
                z.writestr(guid+'/snapshot.png',raw);child(vp,'Snapshot','snapshot.png')
            z.writestr(guid+'/markup.bcf',xml(markup));z.writestr(guid+'/viewpoint.bcfv',xml(info))
        z.writestr('Documents/uvyazka-report.json',json.dumps(report,ensure_ascii=False,allow_nan=False))
    return output.getvalue()


def xlsx(report):
    """Editable issue register: numeric distances, literal strings, full provenance."""
    columns=['№','ID','Тип','Статус','Проверка','Элемент A','Revit ID A','IFC GUID A','Элемент B','Revit ID B','IFC GUID B','Зазор, мм','Допуск, мм','Источник SHA-256','Основание']
    issues=[columns]
    for n,row in enumerate(report['issues'],1):
        distance=row['evidence'].get('distance_m')
        issues.append([n,row['id'],row['kind'],row.get('status','new'),report['rule']['name'],row['a']['name'],row['a'].get('revit_id') or '',row['a'].get('ifc_guid') or '',row['b']['name'],row['b'].get('revit_id') or '',row['b'].get('ifc_guid') or '',distance*1000 if distance is not None else '',report['rule'].get('tolerance_mm',1),report['source_sha256'],row.get('reason','')])
    coverage=[['Показатель','Значение'],['Статус прогона',report['status']],['Полнота выбранного состава',str(report['complete'])],['Область',report.get('scope','')]]
    for k,v in report['coverage'].items():coverage.append([k,json.dumps(v,ensure_ascii=False) if isinstance(v,(list,dict)) else v])
    sources=[['Замечание','Сторона','Источник / объект','Доказательство']]
    for row in report['issues']:
        for side in ('a','b'):sources.append([row['id'],side,json.dumps(row[side],ensure_ascii=False),json.dumps(row['evidence'],ensure_ascii=False)])
    return workbook([('Замечания',issues),('Покрытие',coverage),('Источники',sources)])


def workbook(sheets):
    output=io.BytesIO();main='http://schemas.openxmlformats.org/spreadsheetml/2006/main';rel='http://schemas.openxmlformats.org/package/2006/relationships'
    def column(i):
        result=''
        while i:i,mod=divmod(i-1,26);result=chr(65+mod)+result
        return result
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        types=X.Element('Types',xmlns='http://schemas.openxmlformats.org/package/2006/content-types')
        for ext,mime in [('rels','application/vnd.openxmlformats-package.relationships+xml'),('xml','application/xml')]:child(types,'Default',Extension=ext,ContentType=mime)
        child(types,'Override',PartName='/xl/workbook.xml',ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
        rootrels=X.Element('Relationships',xmlns=rel);child(rootrels,'Relationship',Id='rId1',Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',Target='xl/workbook.xml');z.writestr('_rels/.rels',xml(rootrels))
        book=X.Element('workbook',xmlns=main);entries=child(book,'sheets');rels=X.Element('Relationships',xmlns=rel)
        for i,(name,rows) in enumerate(sheets,1):
            if len(rows)>1048576:raise ValueError('Excel row limit exceeded')
            child(entries,'sheet',name=name,sheetId=str(i),**{'{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id':'rId'+str(i)})
            child(rels,'Relationship',Id='rId'+str(i),Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',Target='worksheets/sheet'+str(i)+'.xml')
            sheet=X.Element('worksheet',xmlns=main);views=child(sheet,'sheetViews');view=child(views,'sheetView',workbookViewId='0');child(view,'pane',ySplit='1',topLeftCell='A2',activePane='bottomLeft',state='frozen')
            data=child(sheet,'sheetData')
            for r,values in enumerate(rows,1):
                row=child(data,'row',r=str(r))
                for c,value in enumerate(values,1):
                    cell=child(row,'c',r=column(c)+str(r))
                    if type(value) in (int,float) and math.isfinite(value):child(cell,'v',value)
                    else:
                        value=text(value)
                        if len(value)>32767:raise ValueError('Excel cell limit exceeded; use JSON')
                        cell.set('t','inlineStr');child(child(cell,'is'),'t',value,**{'{http://www.w3.org/XML/1998/namespace}space':'preserve'})
            if rows:child(sheet,'autoFilter',ref='A1:'+column(len(rows[0]))+str(len(rows)))
            z.writestr('xl/worksheets/sheet'+str(i)+'.xml',xml(sheet));child(types,'Override',PartName='/xl/worksheets/sheet'+str(i)+'.xml',ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
        z.writestr('xl/workbook.xml',xml(book));z.writestr('xl/_rels/workbook.xml.rels',xml(rels));z.writestr('[Content_Types].xml',xml(types))
    return output.getvalue()

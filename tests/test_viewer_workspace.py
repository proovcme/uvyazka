import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
from uvyazka.core import Workspace
from uvyazka.demo import create_demo
from uvyazka.construction.viewer_workspace import ViewerWorkspace,RevisionConflict,validate
from uvyazka.construction.engineering import network_page
from uvyazka.dashboard import make_handler


def state():
    return {'version':1,'model_id':'a'*64,'source_sha256':'b'*64,'hidden':['2'],'selection':['1'],
        'filters':{'query':'Насос','levels':[],'categories':[],'system':'','parameters':[],'combine':'all','apply3d':True,'grouping':'levels'},
        'view':{'position':[1,2,3],'target':[0,0,0],'up':[0,1,0],'planes':[{'normal':[0,0,1],'constant':-2}],'xray':False},'measurements':[],'sets':[]}


class ViewerWorkspaceTests(unittest.TestCase):
    def test_specification_recipes_roundtrip_and_reject_invalid_conditions(self):
        s=state()
        definition={'version':1,'name':'Синтетическая ведомость','model_id':'a'*64,'source_hashes':['b'*64],
            'columns':[{'id':'count','label':'Записей','aggregate':'sum'}], 'group_by':[],
            'filters':[{'field_id':'count','operator':'greater','value':0,'unit':'record'}],
            'sort':{'id':'count','direction':1},'scope':'selection','scope_ids':['1']}
        s['specifications']=[definition]
        self.service.save('demo-a',s,0,'with-specification')
        self.assertEqual(self.service.get('demo-a')['state']['specifications'],[definition])
        for mutate in [lambda p:p.update(source_hashes=['private-path']),lambda p:p['columns'].append(dict(p['columns'][0])),lambda p:p['filters'][0].update(value=float('nan')),lambda p:p.update(sort={'id':'not-a-column','direction':1}),lambda p:p.update(arbitrary='field')]:
            bad=copy.deepcopy(s);mutate(bad['specifications'][0])
            with self.assertRaises(ValueError):validate(bad)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.ws=Workspace(Path(self.temp.name)/'state');create_demo(self.ws);self.service=ViewerWorkspace(self.ws)

    def test_revision_history_idempotency_conflicts_and_project_isolation(self):
        self.assertEqual(self.service.get('demo-a')['revision'],0)
        s=state();one=self.service.save('demo-a',s,0,'one');self.assertEqual(one,self.service.save('demo-a',s,0,'one'))
        changed=copy.deepcopy(s);changed['hidden']=[]
        with self.assertRaises(ValueError):self.service.save('demo-a',changed,0,'one')
        with self.assertRaises(RevisionConflict):self.service.save('demo-a',changed,0,'two')
        self.service.save('demo-a',changed,1,'two')
        self.assertEqual(self.service.get('demo-a',1)['state'],s)
        self.assertEqual(self.service.get('demo-a')['state'],changed)
        self.assertEqual(self.service.get('demo-b')['revision'],0)
        with self.assertRaises(ValueError):self.service.get('does-not-exist')

    def test_concurrent_writers_cannot_overwrite_same_revision(self):
        def write(i):
            try:return self.service.save('demo-a',state(),0,str(i))['revision']
            except RevisionConflict:return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(write,[1,2]))
        self.assertCountEqual(results,[1,'conflict'])

    def test_validation_rejects_nonfinite_nested_unknown_fields_and_unpinned_sets(self):
        for change in [lambda s:s.update(source_sha256=''),lambda s:s.update(secret='not a field'),lambda s:s['view']['position'].__setitem__(0,float('nan')),lambda s:s['view']['planes'][0].update(normal=[0,0,0]),lambda s:s.update(hidden=['1','1']),lambda s:s.update(sets=[{'id':'x','name':'x','kind':'explicit','ids':[]}])]:
            s=state();change(s)
            with self.assertRaises(ValueError):validate(s)
        s=state();s['sets']=[{'id':'x','name':'Насосы','kind':'rule','model_id':'a'*64,'source_sha256':'b'*64,'ids':[],'created_at':'synthetic','filters':s['filters']}];validate(s)

    def test_loopback_http_rejects_untrusted_write_and_returns_conflict(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.ws));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        base=f'http://127.0.0.1:{server.server_port}'
        token=json.load(urlopen(base+'/api/viewer/config'))['token']
        route=base+'/api/viewer/workspace?project_id=demo-a'
        def send(headers,revision=0,request_id='http'):
            return urlopen(Request(route,data=json.dumps({'state':state(),'expected_revision':revision,'request_id':request_id}).encode(),headers={'Content-Type':'application/json',**headers},method='POST'))
        with self.assertRaises(HTTPError) as error:send({})
        self.assertEqual(error.exception.code,403)
        with self.assertRaises(HTTPError) as error:send({'X-Uvyazka-Token':token,'Origin':'https://example.invalid'})
        self.assertEqual(error.exception.code,403)
        self.assertEqual(json.load(send({'X-Uvyazka-Token':token}))['revision'],1)
        with self.assertRaises(HTTPError) as error:send({'X-Uvyazka-Token':token},request_id='stale')
        self.assertEqual(error.exception.code,409)
        self.assertEqual(json.load(urlopen(route))['state'],state())

    def test_native_ifc_import_preserves_systems_and_port_topology(self):
        try:
            import ifcopenshell
            import ifcopenshell.api
        except ImportError:
            self.skipTest('Optional IfcOpenShell not installed')
        from uvyazka.construction.importer import import_model
        model=ifcopenshell.api.run('project.create_file')
        ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcProject',name='Synthetic')
        ifcopenshell.api.run('unit.assign_unit',model)
        context=ifcopenshell.api.run('context.add_context',model,context_type='Model')
        body=ifcopenshell.api.run('context.add_context',model,context_type='Model',context_identifier='Body',target_view='MODEL_VIEW',parent=context)
        wall=ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcWall',name='Synthetic equipment stand')
        representation=ifcopenshell.api.run('geometry.add_wall_representation',model,context=body,length=1,height=2,thickness=.2)
        ifcopenshell.api.run('geometry.assign_representation',model,product=wall,representation=representation)
        system=ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcDistributionSystem',name='Synthetic system')
        ports=[ifcopenshell.api.run('root.create_entity',model,ifc_class='IfcDistributionPort',name='Port '+str(i)) for i in range(2)]
        model.create_entity('IfcRelAssignsToGroup',GlobalId=ifcopenshell.guid.new(),RelatingGroup=system,RelatedObjects=[wall])
        model.create_entity('IfcRelNests',GlobalId=ifcopenshell.guid.new(),RelatingObject=wall,RelatedObjects=ports)
        relation=model.create_entity('IfcRelConnectsPorts',GlobalId=ifcopenshell.guid.new(),RelatingPort=ports[0],RelatedPort=ports[1])
        root=Path(self.temp.name);source=root/'network.ifc';model.write(str(source));import_model(str(source),str(root/'imported'))
        package=json.loads((root/'imported/manifest.json').read_text(encoding='utf8'))
        self.assertEqual(package['systems'][0]['member_ids'],[str(wall.id())])
        graph=network_page(package,str(ports[0].id()),str(ports[1].id()))
        self.assertEqual(graph['path']['status'],'found')
        self.assertEqual(graph['path']['links'][0]['source']['relation_id'],':'+str(relation.id()))
        self.assertIsNone(next(e for e in package['elements'] if e['id']==str(wall.id()))['storey_id'])

    def test_network_membership_is_not_physical_and_explicit_sources_survive(self):
        m={'model_id':'a'*64,'source':{'sha256':'b'*64},'elements':[{'id':i,'name':i,'class':'IfcPump','hierarchy':['IfcElement'],'source':{'file_sha256':'b'*64}} for i in ['1','2']],
           'systems':[{'id':'sys','name':'В1','class':'IfcSystem','member_ids':['1','2']}],'relationships':[]}
        self.assertEqual(network_page(m,'1','2')['path']['status'],'not_found_in_read_graph')
        self.assertEqual(network_page(m,'1','2','membership')['path']['status'],'found')
        m['relationships']=[{'step_id':3,'class':'IfcRelConnectsElements','parent_id':'1','child_ids':['2','unread']}]
        r=network_page(m,'1','2');self.assertEqual(r['path']['status'],'found');self.assertEqual(r['coverage']['unread_nodes'],1);self.assertEqual(r['path']['links'][0]['source']['relation_class'],'IfcRelConnectsElements')
        self.assertEqual(network_page(m,limit=1)['next_offset'],1)


if __name__=='__main__':unittest.main()

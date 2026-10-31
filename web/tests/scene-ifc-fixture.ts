import {federate} from '../src/federation.ts';
import {fixture} from './reliability-fixture.ts';

/** Synthetic only: source names describe formats, not real projects. */
export async function sceneIfcFixture(){
 const a=fixture(),b=fixture();
 a.model.model_id='a'.repeat(64);a.model.source.sha256='a'.repeat(64);a.model.source.filename='synthetic.ifc';a.model.source.format='ifc';
 a.model.coordinate_system.length_to_m=.3048;
 a.model.elements[0].id='pump';a.model.elements[0].global_id='0000000000000000000001';a.model.elements[0].name='Насос 😀';a.model.elements[0].storey_id='level';
 a.model.elements[0].property_sets={Engineering:{Zero:0,False:false,Empty:'',Unknown:null,Data:{Label:'Проверка',Ids:['9007199254740993'],Flag:false},Literal:"');ENDSEC;#1=IFCPROXY();",LongText:'Источник 😀'.repeat(1800)}};
 a.model.elements[0].revit={element_id:'9007199254740993',unique_id:'synthetic-unique',phase_status:'not_read'};
 a.model.elements[0].mesh!.styles=[{name:'Синий',color:[.1,.3,.8],opacity:.35}];
 a.model.storeys=[{id:'level',name:'Этаж',elevation_m:null,placement_origin_m:[0,0,7],element_count:1}];a.model.relationships=[];a.model.systems=[];
 b.model.model_id='b'.repeat(64);b.model.source.sha256='b'.repeat(64);b.model.source.filename='synthetic.nwc';b.model.source.format='nwc';
 b.model.elements[0].id='line';b.model.elements[0].name='Линия';b.model.elements[0].global_id='0000000000000000000001';b.model.elements[0].storey_id=null;b.model.elements[0].mesh!.primitive='lines';
 b.model.elements[0].mesh!.index_count=2;new Uint32Array(b.binary,b.model.elements[0].mesh!.index_byte_offset,3).set([0,1,0]);b.model.statistics.triangles=0;b.model.storeys=[];b.model.relationships=[];b.model.systems=[];
 b.model.elements.push({...b.model.elements[0],id:'owner',name:'Исходный узел',global_id:'',role:'other',semantic_kind:'source_node',mesh:null,property_sets:{Original:{Value:12}},nwd:{kind:'node',namespace:'synthetic',node_index:0,parent_id:null}});
 b.model.elements[0].nwd={kind:'fragment',namespace:'synthetic',owner_id:'owner'};
 const members=[{instanceId:'ifc-source',model:a.model,binary:a.binary,offset:[1000000,2000000,30] as [number,number,number],rotation:90,visible:true},{instanceId:'nwc-source',model:b.model,binary:b.binary,offset:[1000010,2000020,35] as [number,number,number],rotation:0,visible:true}];
 const result=await federate(members);
 result.model.systems=[{id:'system',class:'IfcSystem',name:'П1',member_ids:['ifc-source:pump','nwc-source:line','missing'],connectivity_verified:false}];
 return {...result,members};
}

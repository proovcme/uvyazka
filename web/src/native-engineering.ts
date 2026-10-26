import type {ModelPackage} from './model';
import {elementIdentity} from './element-identity.ts';
export interface NativeEngineering {status:string;diagnostics:string[];systems:{system:{id:number;class:string;name:string|null;member_evidence:{element_id:number;object_index:number;field:string;entry_index:number;connection_type:number;role:string}[]};source:{stream:string;group_record_offset:number;body_sha256:string}}[]}
export function attachNativeEngineering(model:ModelPackage,report:NativeEngineering,sha256:string){
 const ids=new Map<string,string[]>();for(const e of model.elements){const id=elementIdentity(e).element_id;if(id)ids.set(id,[...(ids.get(id)??[]),e.id]);}
 if(report.status==='unsupported_version'||!report.systems.length){for(const message of report.diagnostics)model.diagnostics.push({element_id:'',kind:'native_mep',message});return;}
 const links:NonNullable<ModelPackage['engineering_links']>=[],systems:NonNullable<ModelPackage['systems']>=[];
 for(const row of report.systems){const system=row.system,sid='rvt-system:'+system.id,members=new Set<string>();
  for(const entry of system.member_evidence){
   const mapped=ids.get(String(entry.element_id)),id=mapped?.length===1?mapped[0]:'rvt-element:'+entry.element_id;
   const kind=entry.role==='base_equipment_reference'?'base_equipment':entry.role==='network_member'?'membership':null;if(!kind)continue;
   if(kind==='membership')members.add(id);
   links.push({id:`${sid}:${entry.object_index}:${entry.field}:${entry.entry_index}`,from:sid,to:id,kind,source:{sha256,relation_id:String(system.id),relation_class:system.class,locator:`${row.source.stream}@${row.source.group_record_offset}; body_sha256=${row.source.body_sha256}; objects[${entry.object_index}].fields.${entry.field}[${entry.entry_index}]; role=${entry.role}; connection_type=${entry.connection_type}`}});
  }
  systems.push({id:sid,name:system.name??system.class,class:system.class,member_ids:[...members],connectivity_verified:false,description:'Типизированная запись RVT; полнота и работоспособность не подтверждены.'});
 }
 // All IFC groups here were derived by this RVT converter from these same records.
 // Replace that lossy projection with source-addressed native roles, never merge by name.
 const old=new Set((model.systems??[]).map(s=>s.id));model.relationships=model.relationships.filter(r=>r.class!=='IfcRelAssignsToGroup'||!old.has(r.parent_id));
 model.systems=systems;model.engineering_links=[...(model.engineering_links??[]),...links];
 for(const message of report.diagnostics)model.diagnostics.push({element_id:'',kind:'native_mep',message});
 if(report.status==='partial')model.diagnostics.push({element_id:'',kind:'native_mep',message:'Native system projection is partial; omitted systems and connections remain unverified.'});
}

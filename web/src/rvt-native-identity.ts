import type {ModelPackage} from './model.ts';
import type {RvtDocument} from './rvt-document.ts';
import {elementIdentity} from './element-identity.ts';
const exactId=(value:unknown)=>typeof value==='string'&&/^\d+$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):null;

/** Enrich an IFC projection only through an unambiguous current native identity. */
export function attachNativeIdentities(model:ModelPackage,document:RvtDocument|null,hash:string){
 const data=document?.schedule_data;if(!data)return;
 const warn=(id:string,message:string)=>model.diagnostics.push({element_id:id,kind:'rvt_native_identity',message});
 if(model.source.format!=='rvt'||model.source.sha256!==hash||document?.source?.sha256!==hash||data.source_sha256!==hash){warn('','Native identity source hash mismatch; identities were not attached.');return;}
 const native=new Map<string,typeof data.records>();
 for(const record of data.records){const id=exactId(record.identity.element_id);if(id)native.set(id,[...(native.get(id)??[]),record]);}
 const scene=new Map<string,typeof model.elements>();
 for(const element of model.elements){const id=elementIdentity(element).element_id;if(id)scene.set(id,[...(scene.get(id)??[]),element]);}
 for(const [id,elements]of scene){
  const records=native.get(id);if(!records?.length)continue;
  if(elements.length!==1||records.length!==1){warn(elements[0].id,'Ambiguous native identity match; UniqueId was not attached.');continue;}
  const element=elements[0],record=records[0],unique=record.identity.unique_id;
  if(typeof unique!=='string'||!unique.trim())continue;
  const previous=elementIdentity(element).unique_id;
  if(previous&&previous!==unique){warn(element.id,'Conflicting native UniqueId; existing identity was retained for review.');continue;}
  element.revit={...element.revit,element_id:id,unique_id:unique,id_basis:'rvt_native_identity',phase_status:element.revit?.phase_status??'not_read',identity_source:{file_sha256:hash,record_source:record.source,identity_row_offset:record.identity.row_offset}};
 }
}

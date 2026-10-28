import {category,recordName} from './rvt-document.ts';
import type {NativeRecord,RvtDocument} from './rvt-document.ts';
export const documentLabels:Record<string,string>={sheets:'Листы',views:'Планы и разрезы','3d':'3D-виды',schedules:'Спецификации',templates:'Шаблоны видов',placements:'Размещения',other:'Другие виды'};
export function recordMatches(record:NativeRecord,query:string){
 const q=query.trim().toLocaleLowerCase();
 if(/^(?:revit:|#)\d+$/.test(q))return String(record.identity.element_id)===q.replace(/^(?:revit:|#)/,'');
 return q.split(/\s+/).filter(Boolean).every(token=>`${recordName(record)} ${record.identity.element_id} ${record.class_name} ${documentLabels[category(record)]}`.toLocaleLowerCase().includes(token));
}
/** Dense paper/ink tree, existing 34px rows and amber selection; no geometry checkboxes for documents.
 * Engineers navigate source-owned records. Name leads, ID/status follow in smaller muted text.
 * Native details preserve keyboard access; 50-row pages keep the tool panel responsive. */
export function documentBranches(host:HTMLElement,data:RvtDocument,query:string,open:(document:RvtDocument,record:NativeRecord)=>void,expanded:Set<string>){
 const groups=new Map<string,NativeRecord[]>();
 for(const record of data.records){if(!recordMatches(record,query))continue;const kind=category(record);if(!groups.has(kind))groups.set(kind,[]);groups.get(kind)!.push(record);}
 const note=document.createElement('p');note.className='document-tree-note';note.textContent=`Спецификации RVT · ${groups.get('schedules')?.length??0} · полнота не подтверждена`;host.append(note);
 const technical=document.createElement('details'),technicalTitle=document.createElement('summary');technical.className='document-tree-note';technicalTitle.textContent='Исходный каталог · без графического просмотра';technical.append(technicalTitle);
 const warning=document.createElement('p');warning.textContent='Виды и листы пока доступны только как записи файла, без графического отображения.';technical.append(warning);
 for(const [kind,records] of groups){
  const group=document.createElement('details');group.className='model-branch branch-document';const key=data.source?.sha256+':'+kind;group.open=expanded.has(key)||!!query.trim();
  const summary=document.createElement('summary'),name=document.createElement('span'),count=document.createElement('small');name.className='tree-node-name';name.textContent=documentLabels[kind];count.textContent=String(records.length);summary.append(name,count);group.append(summary);(kind==='schedules'?host:technical).append(group);
  let loaded=false;const populate=()=>{if(loaded)return;loaded=true;const list=document.createElement('div');list.className='tree-document-list';group.append(list);let limit=50;
   const draw=()=>{list.replaceChildren();for(const record of records.slice(0,limit)){const button=document.createElement('button');button.className='document-item';button.dataset.documentHash=data.source?.sha256;button.dataset.recordId=String(record.identity.element_id);const label=document.createElement('strong'),id=document.createElement('small');label.textContent=recordName(record);id.textContent=`Revit ${record.identity.element_id}${record.diagnostic||!record.graph?' · есть пропуски':''}`;button.append(label,id);button.onclick=()=>open(data,record);list.append(button);}if(records.length>limit){const more=document.createElement('button');more.className='tree-more';more.textContent=`Ещё ${Math.min(50,records.length-limit)}`;more.onclick=()=>{limit+=50;draw();};list.append(more);}};draw();};
  group.addEventListener('toggle',event=>{if(event.target!==group||!group.isConnected)return;if(group.open){expanded.add(key);populate();}else expanded.delete(key);});if(group.open)populate();
 }
 if(technical.querySelector('.branch-document'))host.append(technical);
 if(!groups.size){const none=document.createElement('p');none.className='document-tree-note';none.textContent=data.records.length?'Документы не совпали с поиском по имени или ID.':'Читаемые записи не получены; отсутствие видов и таблиц не подтверждено.';host.append(none);}
}

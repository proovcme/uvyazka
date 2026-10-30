import type {ModelPackage} from './model';
import {displayClass,displayElementName} from './ui-language.ts';
import {engineeringGraph,engineeringNeighbours,engineeringComponent,engineeringPath,linkLabel} from './engineering-graph';

export function engineeringPanel(host:HTMLElement,getModel:()=>ModelPackage|null,actions:{select:(id:string)=>void;highlight:(ids:string[])=>void;isolate:(ids:string[])=>void}){
 let current:string|null=null,anchor:string|null=null,mode:'physical'|'membership'='physical';
 const node=(tag:string,text:string,parent:HTMLElement=host)=>{const e=document.createElement(tag);e.textContent=text;parent.append(e);return e;};
 const button=(text:string,run:()=>void,parent:HTMLElement=host)=>{const b=node('button',text,parent)as HTMLButtonElement;b.type='button';b.onclick=run;return b;};
 function open(id:string|null){current=id;render();}
 function render(){
  host.replaceChildren();const model=getModel();if(!model){node('p','Сначала откройте модель.');return;}
  const graph=engineeringGraph(model),item=current?graph.nodes.get(current):null;
  node('p','Связи из файла',host).className='eyebrow';
  const info=node('p','Системы, соединения и ссылки на базовое оборудование показаны отдельно. Путь по связям файла не подтверждает питание, проходимость, расход, защиту или работоспособность сети.');info.className='network-note';
  const choose=document.createElement('select');choose.setAttribute('aria-label','Тип цепочки');choose.append(new Option('Физические соединения','physical'),new Option('Системы и базовое оборудование','membership'));choose.value=mode;choose.onchange=()=>{mode=choose.value as typeof mode;render();};host.append(choose);
  if(!item){node('p','Выберите оборудование или элемент модели.');}
  else{
   node('h3',displayElementName(item.name,item.class));node('p',`${displayClass(item.class)}${item.geometry?'':' · без отображения на модели'}`);
   const tools=node('div','');tools.className='network-actions';
   button('Начало пути',()=>{anchor=item.id;render();},tools);
   button('Подсветить сеть',()=>{const c=engineeringComponent(graph,item.id,mode);actions.highlight(c.ids);status.textContent=c.truncated?'Достигнут лимит обхода: показана часть сети.':`В прочитанном графе: ${c.ids.length} узлов`;},tools);
   button('Только сеть',()=>{const c=engineeringComponent(graph,item.id,mode);actions.isolate(c.ids.filter(id=>graph.nodes.get(id)?.geometry));if(c.truncated)status.textContent='Показана часть сети: достигнут лимит обхода.';},tools);
   if(anchor){node('p','Начало: '+(graph.nodes.get(anchor)?.name??anchor));button('Путь до выбранного',()=>{
    const path=engineeringPath(graph,anchor!,item.id,mode);actions.highlight([...path.nodes]);
    status.textContent=path.status==='found'?`Цепочка: ${path.links.length} связей`:'Путь не найден в прочитанных данных. Это не доказательство отсутствия подключения.';
    if(path.status==='found')for(const link of path.links)evidence(linkLabel[link.kind],link.source);
   });button('Сбросить начало',()=>{anchor=null;render();});}
   const rows=engineeringNeighbours(graph,item.id);node('h4',`Связи элемента · ${rows.length}`);
   for(const {node:n,link}of rows.slice(0,150)){
    const row=node('div','');row.className='network-row';
    const b=button(n.name,()=>{if(n.role==='element'||n.role==='port')actions.select(n.id);open(n.id);},row);b.disabled=n.role==='unread';
    node('small',`${linkLabel[link.kind]} · ${displayClass(n.class)}`,row);evidence('Источник связи',{...link.source,from:link.from,to:link.to},row);
   }
   if(rows.length>150)node('p','Показаны первые 150 связей. Экспорт содержит полный граф.');
   if(!rows.length)node('p','Связи этого элемента не прочитаны. Подключение не проверено.');
  }
  const status=node('p','');status.setAttribute('role','status');
  const issues=node('details','')as HTMLDetailsElement;node('summary','Покрытие и ограничения',issues);for(const issue of graph.issues)node('p',issue,issues);
  node('p',`${graph.nodes.size} узлов · ${graph.links.length} связей. Источник: ${model.source.sha256}`,issues);
  button('Снять подсветку',()=>actions.highlight([]));
  button('Скачать граф JSON',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({model_id:model.model_id,source:model.source,nodes:[...graph.nodes.values()],links:graph.links,issues:graph.issues},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='engineering-graph.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
 }
 function evidence(label:string,source:unknown,parent:HTMLElement=host){const d=node('details','',parent);node('summary',label,d);node('pre',JSON.stringify(source,null,2),d);}
 return {open,reset:()=>{anchor=null;current=null;render();}};
}

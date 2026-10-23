import type {BimElement,ModelPackage} from './model';
import {elementIdentity} from './element-identity.ts';
import type {ModelVisibility} from './model-visibility';
interface Node {key:string;name:string;kind:'model'|'storey'|'class';items:BimElement[];children:Node[]}
export function modelTreeNodes(model:ModelPackage,items:BimElement[]):Node[]{
  const roots:Node[]=[],sources=new Map<string,Node>(),floors=new Map<string,Node>(),classes=new Map<string,Node>();
  const levels=new Map(model.storeys.map(s=>[s.id,s.name]));
  for(const e of items){
    const source=e.source_instance_id??'',floor=e.storey_id??'';
    let root=sources.get(source);if(!root){root={key:JSON.stringify(['model',source]),name:model.federation?.members.find(m=>m.instance_id===source)?.label??(model.federation?(source?'Источник '+source:'Источник не прочитан'):model.source.filename),kind:'model',items:[],children:[]};sources.set(source,root);roots.push(root);}root.items.push(e);
    const fk=JSON.stringify(['storey',source,floor]);let level=floors.get(fk);if(!level){level={key:fk,name:levels.get(floor)||'Без этажа',kind:'storey',items:[],children:[]};floors.set(fk,level);root.children.push(level);}level.items.push(e);
    const ck=JSON.stringify(['class',source,floor,e.class]);let category=classes.get(ck);if(!category){category={key:ck,name:e.class,kind:'class',items:[],children:[]};classes.set(ck,category);level.children.push(category);}category.items.push(e);
  }
  return roots;
}
/** Native details/checkboxes, lazy category rows, and stable expansion during visibility changes. */
export function modelTreePanel(host:HTMLElement,visibility:ModelVisibility,actions:{select:(id:string)=>void;show:(ids:string[],visible:boolean)=>void;isolate:(ids:string[])=>void}){
  let current:ModelPackage|null=null;const expanded=new Map<string,boolean>(),limits=new Map<string,number>(),offsets=new Map<string,number>();
  let lastItems:BimElement[]=[],lastSearching=false,lastSearchKey='';
  function render(model:ModelPackage|null,items:BimElement[],selected:string|null,searching:boolean,searchKey=String(searching)){
    if(current!==model){current=model;expanded.clear();limits.clear();offsets.clear();}
    if(lastSearchKey!==searchKey){expanded.clear();limits.clear();offsets.clear();lastSearchKey=searchKey;}
    lastItems=items;lastSearching=searching;
    host.replaceChildren();if(!model)return;
    const stats=document.createElement('p');stats.className='tree-results';const visible=visibility.count(items.map(e=>e.id));stats.textContent=`Найдено ${items.length} · включено ${visible.shown}`;host.append(stats);
    if(!items.length){const empty=document.createElement('p');empty.textContent='Совпадений нет. Измените поиск или фильтры.';host.append(empty);return;}
    const branch=(node:Node):HTMLDetailsElement=>{
      const details=document.createElement('details');details.className='model-branch branch-'+node.kind;
      details.open=expanded.get(node.key)??(node.kind!=='class'||searching||node.items.some(e=>e.id===selected));
      const summary=document.createElement('summary'),check=document.createElement('input');check.type='checkbox';
      const ids=node.items.map(e=>e.id),state=visibility.count(ids);check.checked=state.checked;check.indeterminate=state.mixed;
      check.setAttribute('aria-label','Показывать '+node.name);check.onclick=e=>e.stopPropagation();check.onchange=()=>actions.show(ids,check.checked);
      const name=document.createElement('span');name.textContent=node.name;name.className='tree-node-name';
      const count=document.createElement('small');count.textContent=String(node.items.length);count.title=`Включено ${state.shown} из ${state.total}`;
      const only=document.createElement('button');only.className='tree-isolate';only.textContent='Только';only.title='Оставить только '+node.name;only.setAttribute('aria-label',only.title);only.onclick=e=>{e.stopPropagation();actions.isolate(ids);};
      summary.append(check,name,count,only);details.append(summary);
      let loaded=false;
      const populate=()=>{
        if(loaded)return;loaded=true;
        if(node.children.length){for(const child of node.children)details.append(branch(child));return;}
        const list=document.createElement('div');list.className='tree-element-list';details.append(list);
        const rows=()=>{
          list.replaceChildren();const limit=limits.get(node.key)??50,offset=offsets.get(node.key)??0;
          if(offset){const prev=document.createElement('button');prev.className='tree-more';prev.textContent='Предыдущие 50';prev.onclick=()=>{offsets.set(node.key,Math.max(0,offset-50));limits.set(node.key,50);rows();};list.append(prev);}
          for(const element of node.items.slice(offset,offset+limit)){
            const row=document.createElement('div');row.className='tree-element-row';row.dataset.visible=String(visibility.visible(element.id));
            const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=visibility.visible(element.id);toggle.disabled=!element.mesh;toggle.setAttribute('aria-label','Показывать '+(element.name||element.id));toggle.title=element.mesh?'Показать / скрыть элемент':'Геометрия не прочитана';toggle.onchange=()=>actions.show([element.id],toggle.checked);
            const select=document.createElement('button');select.className='element-item';select.dataset.id=element.id;select.setAttribute('aria-pressed',String(selected===element.id));
            const text=document.createElement('span'),title=document.createElement('strong'),identity=document.createElement('small');title.textContent=element.name||element.id;const revit=elementIdentity(element).element_id;identity.textContent=(revit?'Revit '+revit:'#'+element.id)+(element.mesh?'':' · без геометрии');text.append(title,identity);select.append(text);select.onclick=()=>actions.select(element.id);
            row.append(toggle,select);list.append(row);
          }
          if(node.items.length>offset+limit){const more=document.createElement('button');more.className='tree-more';more.textContent=`Ещё ${Math.min(50,node.items.length-offset-limit)} · осталось ${node.items.length-offset-limit}`;more.onclick=()=>{limits.set(node.key,limit+50);rows();};list.append(more);}
        };rows();
      };
      details.addEventListener('toggle',event=>{if(event.target!==details||!details.isConnected)return;expanded.set(node.key,details.open);if(details.open)populate();});
      if(details.open)populate();return details;
    };
    for(const node of modelTreeNodes(model,items))host.append(branch(node));
  }
  function reveal(id:string){
    if(!current||!lastItems.some(e=>e.id===id)||[...host.querySelectorAll<HTMLElement>('.element-item')].some(e=>e.dataset.id===id))return;
    let nodes=modelTreeNodes(current,lastItems);
    while(nodes.length){const node=nodes.find(n=>n.items.some(e=>e.id===id));if(!node)break;expanded.set(node.key,true);if(node.kind==='class'){offsets.set(node.key,Math.floor(node.items.findIndex(e=>e.id===id)/50)*50);limits.set(node.key,50);}nodes=node.children;}
    render(current,lastItems,id,lastSearching,lastSearchKey);
  }
  return {render,reveal};
}

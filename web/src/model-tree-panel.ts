import type {BimElement,ModelPackage} from './model';
import {elementIdentity} from './element-identity.ts';
import type {ModelVisibility} from './model-visibility';
import {elementCategory} from './element-category.ts';
import {documentBranches} from './rvt-navigation.ts';
import type {RvtDocument,NativeRecord} from './rvt-document.ts';
interface Node {key:string;name:string;kind:'model'|'storey'|'class'|'native';items:BimElement[];children:Node[];nativeId?:string;directItems?:BimElement[]}
function nwdTree(model:ModelPackage,items:BimElement[]):{roots:Node[];remaining:BimElement[]}{
 const sourceNodes=model.elements.filter(e=>e.nwd?.kind==='node'),source=new Map(sourceNodes.map(e=>[e.id,e])),nodes=new Map<string,Node>(),wanted=new Set<string>(),remaining:BimElement[]=[];
 if(!sourceNodes.length)return {roots:[],remaining:items};
 for(const e of sourceNodes)nodes.set(e.id,{key:JSON.stringify(['nwd-tree',e.id]),name:e.name,kind:e.nwd?.parent_id?'native':'model',nativeId:e.id,items:[],directItems:[],children:[]});
 const include=(id:string)=>{let depth=0;while(id&&!wanted.has(id)){if(++depth>256)throw Error('NWD: превышена глубина дерева');wanted.add(id);id=source.get(id)?.nwd?.parent_id??'';}};
 for(const e of items){if(e.nwd?.kind==='node'&&source.has(e.id))include(e.id);else if(e.nwd?.kind==='fragment'&&e.nwd.owner_id&&nodes.has(e.nwd.owner_id)){const owner=nodes.get(e.nwd.owner_id)!;owner.items.push(e);owner.directItems!.push(e);include(e.nwd.owner_id);}else remaining.push(e);}
 const roots:Node[]=[];
 for(const e of sourceNodes){if(!wanted.has(e.id))continue;const node=nodes.get(e.id)!,parent=e.nwd?.parent_id&&nodes.get(e.nwd.parent_id);if(parent)parent.children.push(node);else roots.push(node);}
 const collect=(node:Node,depth=0)=>{if(depth>256)throw Error('NWD: цикл исходного дерева');for(const child of node.children){collect(child,depth+1);for(const e of child.items)node.items.push(e);}};
 for(const root of roots)collect(root);
 return {roots,remaining};
}
export function modelTreeNodes(model:ModelPackage,items:BimElement[],grouping:'categories'|'levels'='categories'):Node[]{
  const native=grouping==='categories'?nwdTree(model,items):{roots:[],remaining:items};items=native.remaining;
  const roots:Node[]=[],sources=new Map<string,Node>(),floors=new Map<string,Node>(),classes=new Map<string,Node>();
  const levels=new Map(model.storeys.map(s=>[s.id,s.name]));
  for(const e of items){
    const source=e.source_instance_id??'',floor=e.storey_id??'';
    let root=sources.get(source);if(!root){root={key:JSON.stringify(['model',source]),name:model.federation?.members.find(m=>m.instance_id===source)?.label??(model.federation?(source?'Источник '+source:'Источник не прочитан'):model.source.filename),kind:'model',items:[],children:[]};sources.set(source,root);roots.push(root);}root.items.push(e);
    let parent=root;
    if(grouping==='levels'){const fk=JSON.stringify(['storey',source,floor]);let level=floors.get(fk);if(!level){level={key:fk,name:levels.get(floor)||'Без уровня',kind:'storey',items:[],children:[]};floors.set(fk,level);root.children.push(level);}level.items.push(e);parent=level;}
    const native=elementCategory(e,model),ck=JSON.stringify(['category',source,grouping==='levels'?floor:'',native.key]);let category=classes.get(ck);if(!category){category={key:ck,name:native.name,kind:'class',items:[],children:[]};classes.set(ck,category);parent.children.push(category);}category.items.push(e);
  }
  return [...native.roots,...roots];
}
/** Native details/checkboxes, lazy category rows, and stable expansion during visibility changes. */
export function modelTreePanel(host:HTMLElement,visibility:ModelVisibility,actions:{select:(id:string,additive?:boolean)=>void;show:(ids:string[],visible:boolean)=>void;isolate:(ids:string[])=>void;document?:(document:RvtDocument,record:NativeRecord)=>void}){
  let current:ModelPackage|null=null;const expanded=new Map<string,boolean>(),limits=new Map<string,number>(),offsets=new Map<string,number>();
  let lastItems:BimElement[]=[],lastSearching=false,lastSearchKey='',lastGrouping:'categories'|'levels'='categories';
  let catalogues:RvtDocument[]=[],documentQuery='';const documentExpanded=new Set<string>();
  function render(model:ModelPackage|null,items:BimElement[],selected:string|null,searching:boolean,searchKey=String(searching),grouping:'categories'|'levels'='categories',documents:RvtDocument[]=catalogues,query=documentQuery){
    catalogues=documents;documentQuery=query;
    if(current!==model){current=model;expanded.clear();limits.clear();offsets.clear();}
    if(lastSearchKey!==searchKey){expanded.clear();limits.clear();offsets.clear();lastSearchKey=searchKey;}
    if(lastGrouping!==grouping){expanded.clear();limits.clear();offsets.clear();lastGrouping=grouping;}
    lastItems=items;lastSearching=searching;
    host.replaceChildren();if(!model&&!documents.length)return;
    const stats=document.createElement('p');stats.className='tree-results';const visible=visibility.count(items.map(e=>e.id));stats.textContent=`Элементов найдено ${items.length} · включено ${visible.shown}`;host.append(stats);
    if(!items.length&&!documents.length){const empty=document.createElement('p');empty.textContent='Совпадений нет. Измените поиск или фильтры.';host.append(empty);return;}
    const matched=new Set<RvtDocument>();
    const roots=model?modelTreeNodes(model,items,grouping):[];
    const sources=model?.federation?.members.map(m=>({key:JSON.stringify(['model',m.instance_id]),name:m.label,hash:m.source_sha256}))??(model?[{key:JSON.stringify(['model','']),name:model.source.filename,hash:model.source.sha256}]:[]);
    const rootDocuments=new Map<string,RvtDocument>();
    for(const source of sources){const data=documents.find(d=>d.source?.sha256===source.hash);if(!data)continue;matched.add(data);rootDocuments.set(source.key,data);if(!roots.some(r=>r.key===source.key))roots.push({key:source.key,name:source.name,kind:'model',items:[],children:[]});}
    const branch=(node:Node):HTMLDetailsElement=>{
      const details=document.createElement('details');details.className='model-branch branch-'+node.kind;
      details.open=expanded.get(node.key)??(node.kind==='model'||node.kind==='storey'||node.kind==='class'&&searching||node.nativeId===selected||node.items.some(e=>e.id===selected));
      const summary=document.createElement('summary'),check=document.createElement('input');check.type='checkbox';
      const ids=node.items.map(e=>e.id),state=visibility.count(ids);check.checked=state.checked;check.indeterminate=state.mixed;
      check.disabled=!ids.length;
      check.setAttribute('aria-label','Показывать '+node.name);check.onclick=e=>e.stopPropagation();check.onchange=()=>actions.show(ids,check.checked);
      const name=document.createElement('span');name.textContent=node.name;name.className='tree-node-name';
      const count=document.createElement('small');count.textContent=String(node.items.length);count.title=`Включено ${state.shown} из ${state.total}`;
      const only=document.createElement('button');only.className='tree-isolate';only.textContent='Только';only.title='Оставить только '+node.name;only.setAttribute('aria-label',only.title);only.onclick=e=>{e.stopPropagation();actions.isolate(ids);};
      only.disabled=!ids.length;
      summary.append(check,name,count);
      if(node.nativeId){
        details.classList.add('has-native-properties');name.title=node.name;
        const tools=document.createElement('span');tools.className='tree-node-actions';tools.append(only);
        const info=document.createElement('button');info.className='tree-isolate';info.textContent='Свойства';info.setAttribute('aria-label','Свойства узла '+node.name);info.onclick=e=>{e.stopPropagation();actions.select(node.nativeId!);};tools.append(info);summary.append(tools);
      }else summary.append(only);
      details.append(summary);
      let loaded=false;
      const populate=()=>{
        if(loaded)return;loaded=true;
        if(node.children.length){
          const holder=document.createElement('div');details.append(holder);
          const children=()=>{holder.replaceChildren();const key=node.key+':children',offset=offsets.get(key)??0;
            if(offset){const previous=document.createElement('button');previous.className='tree-more';previous.textContent='Предыдущие 50 узлов';previous.onclick=()=>{offsets.set(key,Math.max(0,offset-50));children();};holder.append(previous);}
            for(const child of node.children.slice(offset,offset+50))holder.append(branch(child));
            if(offset+50<node.children.length){const more=document.createElement('button');more.className='tree-more';more.textContent=`Следующие 50 узлов · осталось ${node.children.length-offset-50}`;more.onclick=()=>{offsets.set(key,offset+50);children();};holder.append(more);}
          };children();
        }
        if(node.kind==='model'&&rootDocuments.has(node.key))documentBranches(details,rootDocuments.get(node.key)!,documentQuery,(data,record)=>actions.document?.(data,record),documentExpanded);
        const rowItems=node.children.length?node.directItems??[]:node.items;
        if(!rowItems.length&&(node.children.length||node.kind==='model'&&rootDocuments.has(node.key)))return;
        const list=document.createElement('div');list.className='tree-element-list';details.append(list);
        const rows=()=>{
          list.replaceChildren();const limit=limits.get(node.key)??50,offset=offsets.get(node.key)??0;
          if(offset){const prev=document.createElement('button');prev.className='tree-more';prev.textContent='Предыдущие 50';prev.onclick=()=>{offsets.set(node.key,Math.max(0,offset-50));limits.set(node.key,50);rows();};list.append(prev);}
          for(const element of rowItems.slice(offset,offset+limit)){
            const row=document.createElement('div');row.className='tree-element-row';row.dataset.visible=String(visibility.visible(element.id));
            const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=visibility.visible(element.id);toggle.disabled=!element.mesh;toggle.setAttribute('aria-label','Показывать '+(element.name||element.id));toggle.title=element.mesh?'Показать / скрыть элемент':'Геометрия не прочитана';toggle.onchange=()=>actions.show([element.id],toggle.checked);
            const select=document.createElement('button');select.className='element-item';select.dataset.id=element.id;select.setAttribute('aria-pressed',String(selected===element.id));
            const text=document.createElement('span'),title=document.createElement('strong'),identity=document.createElement('small');title.textContent=element.name||element.id;const revit=elementIdentity(element).element_id;identity.textContent=(revit?'Revit '+revit:'#'+element.id)+(element.mesh?'':' · без геометрии');text.append(title,identity);select.append(text);select.onclick=event=>actions.select(element.id,event.ctrlKey||event.metaKey||event.shiftKey);
            row.append(toggle,select);list.append(row);
          }
          if(rowItems.length>offset+limit){const more=document.createElement('button');more.className='tree-more';more.textContent=`Ещё ${Math.min(50,rowItems.length-offset-limit)} · осталось ${rowItems.length-offset-limit}`;more.onclick=()=>{offsets.set(node.key,offset+limit);limits.set(node.key,50);rows();};list.append(more);}
        };rows();
      };
      details.addEventListener('toggle',event=>{if(event.target!==details||!details.isConnected)return;expanded.set(node.key,details.open);if(details.open)populate();});
      if(details.open)populate();return details;
    };
    for(const node of roots)host.append(branch(node));
    for(const data of documents)if(!matched.has(data)){const root=document.createElement('details');root.className='model-branch branch-model document-only';root.open=true;const summary=document.createElement('summary');summary.textContent=(data.source?.filename??'RVT')+' · каталог без привязки к геометрии этой сцены';root.append(summary);documentBranches(root,data,documentQuery,(d,r)=>actions.document?.(d,r),documentExpanded);host.append(root);}
  }
  function reveal(id:string){
    if(!current||!lastItems.some(e=>e.id===id)||[...host.querySelectorAll<HTMLElement>('.element-item')].some(e=>e.dataset.id===id))return;
    const sourceNodes=new Map(current.elements.filter(e=>e.nwd?.kind==='node').map(e=>[e.id,e]));
    let native=current.elements.find(e=>e.id===id);let nativeId=native?.nwd?.kind==='node'?native.id:native?.nwd?.owner_id;
    while(nativeId){const node=sourceNodes.get(nativeId);if(!node)break;expanded.set(JSON.stringify(['nwd-tree',nativeId]),true);const parent=node.nwd?.parent_id;
      if(parent){const children=[...sourceNodes.values()].filter(e=>e.nwd?.parent_id===parent),index=children.findIndex(e=>e.id===nativeId);offsets.set(JSON.stringify(['nwd-tree',parent])+':children',Math.floor(Math.max(0,index)/50)*50);}nativeId=parent??undefined;
    }
    let nodes=modelTreeNodes(current,lastItems,lastGrouping);
    while(nodes.length){const node=nodes.find(n=>n.items.some(e=>e.id===id));if(!node)break;expanded.set(node.key,true);if(node.kind==='class'){offsets.set(node.key,Math.floor(node.items.findIndex(e=>e.id===id)/50)*50);limits.set(node.key,50);}nodes=node.children;}
    render(current,lastItems,id,lastSearching,lastSearchKey,lastGrouping);
  }
  return {render,reveal};
}

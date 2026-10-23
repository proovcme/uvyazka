export interface CadTreeState {filename:string;layers:{name:string;visible:boolean}[];entities:{id:string;type:string;layer:string;visible:boolean|null}[]}
/** Plain messages only: CAD parsing and drawing remain inside the separate CAD app. */
export function cadTreePanel(host:HTMLElement,send:(command:Record<string,unknown>)=>void){
  let state:CadTreeState|null=null;const expanded=new Set<string>(),limits=new Map<string,number>();
  host.replaceChildren();const search=document.createElement('input');search.type='search';search.placeholder='Найти объект: слой, тип, ID…';search.setAttribute('aria-label','Найти объект DWG / DXF');search.className='cad-tree-search';
  const reset=document.createElement('button');reset.textContent='Показать все слои и объекты';reset.onclick=()=>send({kind:'reset-visibility'});
  const status=document.createElement('p'),body=document.createElement('div');host.append(search,reset,status,body);
  const render=()=>{
    body.replaceChildren();if(!state)return;const q=search.value.trim().toLocaleLowerCase(),tokens=q.split(/\s+/).filter(Boolean);
    const matches=state.entities.filter(e=>tokens.every(t=>`${e.id} ${e.type} ${e.layer}`.toLocaleLowerCase().includes(t)));
    status.textContent=`${state.filename} · найдено ${matches.length} из ${state.entities.length} объектов`;
    const root=document.createElement('details');root.className='model-branch branch-model';root.open=true;
    const head=document.createElement('summary'),all=document.createElement('input');all.type='checkbox';all.checked=state.layers.length>0&&state.layers.every(l=>l.visible);all.indeterminate=state.layers.some(l=>l.visible)&&!all.checked;all.setAttribute('aria-label','Показывать чертёж');all.onclick=e=>e.stopPropagation();all.onchange=()=>send({kind:'all-layer-visibility',visible:all.checked});const filename=document.createElement('span');filename.className='tree-node-name';filename.textContent=state.filename;head.append(all,filename);root.append(head);body.append(root);
    for(const layer of state.layers){
      const items=matches.filter(e=>e.layer===layer.name);if(q&&!items.length&&!layer.name.toLocaleLowerCase().includes(q))continue;
      const group=document.createElement('details');group.className='model-branch branch-class';group.open=expanded.has(layer.name)||!!q;
      const summary=document.createElement('summary'),check=document.createElement('input');check.type='checkbox';check.checked=layer.visible;check.setAttribute('aria-label','Показывать слой '+layer.name);check.onclick=e=>e.stopPropagation();check.onchange=()=>send({kind:'layer-visibility',layer:layer.name,visible:check.checked});
      const name=document.createElement('span');name.className='tree-node-name';name.textContent=layer.name;const count=document.createElement('small');count.textContent=String(items.length);
      const isolate=document.createElement('button');isolate.className='tree-isolate';isolate.textContent='Только';isolate.onclick=e=>{e.stopPropagation();send({kind:'isolate-layer',layer:layer.name});};summary.append(check,name,count,isolate);group.append(summary);
      let populated=false;
      const populate=()=>{if(populated)return;populated=true;const rows=document.createElement('div');rows.className='tree-element-list';group.append(rows);const draw=()=>{rows.replaceChildren();const limit=limits.get(layer.name)??50;for(const e of items.slice(0,limit)){const row=document.createElement('div');row.className='tree-element-row';row.dataset.visible=String(e.visible===true&&layer.visible);const shown=document.createElement('input');shown.type='checkbox';shown.checked=e.visible===true&&layer.visible;shown.disabled=e.visible===null;shown.setAttribute('aria-label','Показывать объект '+e.id);shown.onchange=()=>send({kind:'entity-visibility',id:e.id,visible:shown.checked});const choose=document.createElement('button');choose.className='element-item';choose.textContent=e.type+' · #'+e.id;choose.onclick=()=>send({kind:'select-entity',id:e.id});row.append(shown,choose);rows.append(row);}if(items.length>limit){const more=document.createElement('button');more.className='tree-more';more.textContent='Ещё '+Math.min(50,items.length-limit);more.onclick=()=>{limits.set(layer.name,limit+50);draw();};rows.append(more);}};draw();};
      group.ontoggle=()=>{if(!group.isConnected)return;if(group.open){expanded.add(layer.name);populate();}else expanded.delete(layer.name);};if(group.open)populate();root.append(group);
    }
  };
  search.oninput=render;
  return {update:(snapshot:CadTreeState)=>{state=snapshot;render();}};
}

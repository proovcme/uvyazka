// Engineering workbench: the table gets the space; window controls stay quiet.
// Reuse native dialogs, existing typography/paper/ink tokens and 40px controls.
export function installWindowControls(scope:HTMLElement=document.body){
 const view=scope.ownerDocument.defaultView!,Observer=view.MutationObserver;
 const roots=new Map<HTMLElement,MutationObserver>();
 const prepare=(root:HTMLElement)=>{
  if(root.matches('#conversion-dialog,.nwd-unit-dialog'))return;
  root.classList.add('window-resizable');
  const sync=()=>{
   const expanded=root.classList.contains('window-expanded');
   root.querySelectorAll<HTMLButtonElement>('[data-window-maximize]').forEach(b=>{
    b.setAttribute('aria-pressed',String(expanded));
    b.setAttribute('aria-label',expanded?'Вернуть прежний размер окна':'Развернуть окно на весь экран');
    b.title=expanded?'Вернуть прежний размер окна':'Развернуть окно на весь экран';
    const label=expanded?'Прежний размер':'На весь экран',span=b.querySelector('span')!;if(span.textContent!==label)span.textContent=label;
   });
  };
  const toggle=()=>{root.classList.toggle('window-expanded');sync();};
  const headers=root.querySelectorAll<HTMLElement>('.panel-head,.gost-head,:scope.review-panel > header');
  for(const header of headers){
   if(header.querySelector('[data-window-maximize]'))continue;
   const b=document.createElement('button');b.type='button';b.dataset.windowMaximize='';b.className='window-maximize';
   b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/></svg><span>На весь экран</span>';
   b.onclick=toggle;
   const close=[...header.querySelectorAll<HTMLButtonElement>('button')].find(b=>/Закрыть|✕|×/.test((b.getAttribute('aria-label')??'')+' '+b.textContent));
   const actions=document.createElement('div');actions.className='window-actions';actions.append(b);
   if(close?.parentElement===header)actions.append(close);header.append(actions);
   header.addEventListener('dblclick',event=>{if(!(event.target as Element).closest('button,input,select,a'))toggle();});
  }
  sync();
 };
 const bind=(root:HTMLElement)=>{
  if(roots.has(root))return;prepare(root);
  const observer=new Observer(()=>prepare(root));observer.observe(root,{childList:true,subtree:true});roots.set(root,observer);
 };
 const discover=(node:Node)=>{
  if(!(node instanceof view.HTMLElement))return;
  if(node.matches('dialog,.review-panel'))bind(node);
  node.querySelectorAll<HTMLElement>('dialog,.review-panel').forEach(bind);
 };
 discover(scope);
 // Only direct workspace additions: never observe the large BIM element tree.
 const observer=new Observer(records=>{for(const r of records)r.addedNodes.forEach(discover);});
 observer.observe(scope,{childList:true});
 return ()=>{observer.disconnect();for(const o of roots.values())o.disconnect();};
}

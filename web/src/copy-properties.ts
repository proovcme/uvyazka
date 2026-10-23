const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const propertyText=(value:unknown)=>value===null||value===undefined?'Не прочитано':typeof value==='object'?JSON.stringify(value):String(value);
export function copyValue(value:unknown){const text=propertyText(value);return `<span class="property-value">${escape(text)}</span><button class="copy-property" data-copy="${escape(text)}" aria-label="Копировать значение" title="Копировать значение"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/></svg></button>`;}
export function installPropertyCopy(){
  const status=document.createElement('span');status.className='copy-status';status.setAttribute('role','status');document.body.append(status);
  document.addEventListener('click',async event=>{
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');if(!button)return;
    const text=button.dataset.copy??'';
    try{
      try{await navigator.clipboard.writeText(text);}catch{
        const input=document.createElement('textarea');input.value=text;input.className='clipboard-fallback';(button.closest('dialog')||document.body).append(input);input.select();const copied=document.execCommand('copy');input.remove();button.focus({preventScroll:true});if(!copied)throw Error('Clipboard unavailable');
      }
      status.textContent='Скопировано';button.dataset.copied='true';setTimeout(()=>{delete button.dataset.copied;status.textContent='';},1200);
    }catch{status.textContent='Не удалось скопировать. Выделите значение и нажмите Ctrl+C.';}
  });
}

export type Theme='light'|'dark';
export const themeChoice=(saved:string|null):Theme=>saved==='dark'?'dark':'light';
export function initTheme(){
  let saved=null;try{saved=localStorage.getItem('uvyazka-theme');}catch{}
  const apply=(theme:Theme)=>{document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'#f4f6f8':'#12181d');document.dispatchEvent(new CustomEvent('theme-change',{detail:theme}));};
  apply(themeChoice(saved));
  const button=document.getElementById('theme-toggle')!;
  button.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg><span></span>';
  const label=()=>{const dark=document.documentElement.dataset.theme==='dark';button.querySelector('span')!.textContent=dark?'Светлая тема':'Тёмная тема';const title='Включить '+(dark?'светлую':'тёмную')+' тему';button.setAttribute('aria-label',title);button.title=title;};
  label();button.onclick=()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';apply(next);try{localStorage.setItem('uvyazka-theme',next);}catch{}label();};
}

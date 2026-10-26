/** A compact checkbox filter. Empty selection means no restriction. */
export function facetFilter(host:HTMLDetailsElement,title:string,changed:()=>void){
  let choices:{id:string;name:string}[]=[],selection=new Set<string>();
  const summary=document.createElement('summary'),list=document.createElement('div'),clear=document.createElement('button');list.className='facet-options';clear.textContent='Все / сбросить';clear.type='button';host.replaceChildren(summary,list,clear);
  const label=()=>summary.textContent=title+' · '+(selection.size?selection.size:'все');
  const render=()=>{list.replaceChildren();for(const choice of choices){const line=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=selection.has(choice.id);input.value=choice.id;input.onchange=()=>{if(input.checked)selection.add(choice.id);else selection.delete(choice.id);label();changed();};line.append(input,document.createTextNode(choice.name));list.append(line);}label();};
  clear.onclick=()=>{selection.clear();render();changed();};
  return {setChoices:(items:{id:string;name:string}[])=>{choices=items;selection.clear();render();},selected:()=>new Set(selection),restore:(ids:string[])=>{selection=new Set(ids.filter(id=>choices.some(c=>c.id===id)));render();},reset:()=>{selection.clear();render();}};
}

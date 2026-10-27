import {gostColumns} from './gost-settings.ts';
import type {GostReport} from './gost-specification.ts';
export type DrawingCommand={kind:'line';x:number;y:number;x2:number;y2:number;width:number}|{kind:'text';x:number;y:number;text:string;size:number;align:'left'|'center'|'right';angle?:number;muted?:boolean};
export interface GostPage {number:number;commands:DrawingCommand[];row_indices:number[];footer:'form-3'|'form-6'}
export const gostGeometry={width:420,height:297,left:20,right:415,top:5,bottom:292,header:25,minRow:8,firstFooter:55,nextFooter:15} as const;
export type Measure=(text:string,sizeMm:number)=>number;
const plain=(value:string)=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
export function wrapGost(text:string,width:number,size:number,measure:Measure):string[]{
 text=plain(text);if(text.length>5000)throw Error('Текст ячейки превышает бюджет 5000 знаков. Сократите оформление, исходник остаётся в JSON.');
 const result:string[]=[];
 for(const paragraph of text.split(/\r?\n/)){
  let line='';
  for(const word of paragraph.trim().split(/\s+/)){
   if(!word)continue;
   if(measure(word,size)<=width){const candidate=line?line+' '+word:word;if(line&&measure(candidate,size)>width){result.push(line);line=word;}else line=candidate;}
   else {if(line){result.push(line);line='';}for(const char of word){if(line&&measure(line+char,size)>width){result.push(line);line=char;}else line+=char;}}
  }
  result.push(line);
 }
 return result.length?result:[''];
}
export function drawGost(report:GostReport,measure:Measure):GostPage[]{
 if(report.rows.length>10000)throw Error('Бюджет выпуска — 10 000 позиций. Уточните состав спецификации.');
 const pages:GostPage[]=[],g=gostGeometry;let page:GostPage,y=0;
 const line=(x:number,y:number,x2:number,y2:number,width=.18)=>page.commands.push({kind:'line',x,y,x2,y2,width});
 const text=(x:number,y:number,value:string,size=2.5,align:'left'|'center'|'right'='left',angle?:number,muted=false)=>page.commands.push({kind:'text',x,y,text:plain(value),size,align,angle,muted});
 const box=(x:number,y:number,w:number,h:number)=>{line(x,y,x+w,y,.35);line(x,y+h,x+w,y+h,.35);line(x,y,x,y+h,.35);line(x+w,y,x+w,y+h,.35);};
 function fitted(x:number,y:number,w:number,h:number,value:string,size=3){const lines=wrapGost(value,w-3,size,measure);if(lines.length*size*1.3>h-2)throw Error('Реквизит не помещается в основную надпись: '+value.slice(0,50));lines.forEach((v,i)=>text(x+w/2,y+(h-lines.length*size*1.3)/2+size+i*size*1.3,v,size,'center'));}
 function stamp(){const d=report.settings.drawing,x=230,fy=g.bottom-(page.number===1?g.firstFooter:g.nextFooter);box(x,fy,185,g.bottom-fy);
  const stops=[0,10,20,30,40,55,65];for(const dx of stops.slice(1))line(x+dx,fy,x+dx,dx===65?g.bottom:fy+(page.number===1?25:15));
  for(let yy=fy+5;yy<g.bottom;yy+=5)line(x,yy,x+65,yy);
  const labels=['Изм.','Кол.уч.','Лист','№ док.','Подп.','Дата'];labels.forEach((v,i)=>fitted(x+stops[i],fy+(page.number===1?20:10),stops[i+1]-stops[i],5,v,1.8));
  if(page.number===1){
   const roles=[['Разраб.',d.developer],['Проверил',d.checker],['',''],['',''],['Н. контр.',d.normcontrol],['Утв.',d.approver]];
   // Role and surname columns: 20 and 20 mm; signature/date remain blank.
   for(const dx of [20,40,55])line(x+dx,fy+25,x+dx,g.bottom);
   roles.forEach(([role,name],i)=>{text(x+1,fy+28.6+i*5,role,1.8);text(x+21,fy+28.6+i*5,name,2.1);});
   line(x+65,fy+10,x+185,fy+10);line(x+65,fy+25,x+185,fy+25);line(x+65,fy+40,x+185,fy+40);
   line(x+135,fy+25,x+135,g.bottom);line(x+135,fy+30,x+185,fy+30);for(const dx of [150,165])line(x+dx,fy+25,x+dx,fy+40);
   fitted(x+65,fy,120,10,d.designation,4);fitted(x+65,fy+10,120,15,d.project,3);fitted(x+65,fy+25,70,15,d.building,3);
   fitted(x+65,fy+40,70,15,d.title,2.5);fitted(x+135,fy+40,50,15,d.organization,2.5);
   ['Стадия','Лист','Листов'].forEach((v,i)=>fitted(x+135+[0,15,30][i],fy+25,[15,15,20][i],5,v,1.9));
   [d.stage,'1',String(pages.length)].forEach((v,i)=>fitted(x+135+[0,15,30][i],fy+30,[15,15,20][i],10,v,3));
  }else{line(x+175,fy,x+175,g.bottom);line(x+175,fy+8,x+185,fy+8);fitted(x+65,fy,110,15,d.designation,4);fitted(x+175,fy,10,8,'Лист',2);fitted(x+175,fy+8,10,7,String(page.number),3);}
  // Inventory/signature/replacement fields outside the sheet frame (no invented values).
  box(8,g.bottom-85,12,85);line(13,g.bottom-85,13,g.bottom);line(8,g.bottom-60,20,g.bottom-60);line(8,g.bottom-25,20,g.bottom-25);
  text(11.5,g.bottom-12.5,'Инв. № подл.',2,'center',90);text(11.5,g.bottom-42.5,'Подп. и дата',2,'center',90);text(11.5,g.bottom-72.5,'Взам. инв. №',2,'center',90);
  if(page.number===1){box(8,g.bottom-150,12,65);line(13,g.bottom-150,13,g.bottom-85);for(const offset of [140,125,105])line(13,g.bottom-offset,20,g.bottom-offset);text(11.5,g.bottom-117.5,'Согласовано',2,'center',90);}
  text(g.right,g.bottom+3.4,'Формат А3',2,'right');
 }
 function start(){if(pages.length>=300)throw Error('Бюджет выпуска — 300 листов');page={number:pages.length+1,commands:[],row_indices:[],footer:pages.length?'form-6':'form-3'};pages.push(page);box(g.left,g.top,g.right-g.left,g.bottom-g.top);
  if(!report.release_ready)text(g.left,3.4,`ЧЕРНОВИК · вопросов: ${report.issues.filter(i=>i.kind!=='coverage').length}`,2.5);
  let x=g.left;for(const [field,label,width]of gostColumns){line(x,g.top,x,g.top+g.header,.35);const lines=wrapGost(label,width-3,2.6,measure);lines.forEach((v,i)=>text(x+width/2,g.top+4+i*3.5,v,2.6,'center'));x+=width;void field;}line(g.left,g.top+g.header,g.right,g.top+g.header,.35);y=g.top+g.header;
  const section='Оборудование',center=g.left+20+65;text(center,y+5,section,3,'center');line(center-measure(section,3)/2,y+5.6,center+measure(section,3)/2,y+5.6);line(g.left,y+8,g.right,y+8);y+=8;
 }
 start();report.rows.forEach((row,index)=>{const values=gostColumns.map(([field])=>row.cells[field].state==='value'?(typeof row.cells[field].value==='number'?String(row.cells[field].value).replace('.',','):String(row.cells[field].value??'')):'');values[1]=row.number+'. '+values[1];const wrapped=values.map((value,i)=>wrapGost(value,gostColumns[i][2]-3,3,measure));const height=Math.max(g.minRow,Math.max(...wrapped.map(v=>v.length))*3.9+3);
  const limit=()=>g.bottom-(page.number===1?g.firstFooter:g.nextFooter);
  if(height>g.bottom-g.nextFooter-g.top-g.header)throw Error('Позиция не помещается на лист целиком. Сократите описание; исходник сохранён в JSON.');
  if(y+height>limit())start();if(y+height>limit())throw Error('Позиция не помещается на первый лист; нужен отдельный титул или более короткий текст.');
  let x=g.left;wrapped.forEach((lines,i)=>{const width=gostColumns[i][2];line(x,y,x,y+height);lines.forEach((v,n)=>text(i===1||i===2||i===4||i===8?x+1.5:x+width/2,y+4+n*3.9,v,3,i===1||i===2||i===4||i===8?'left':'center'));x+=width;});y+=height;line(g.left,y,g.right,y);page.row_indices.push(index);
 });
 for(const p of pages){page=p;stamp();}
 return pages;
}

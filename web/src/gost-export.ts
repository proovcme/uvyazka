import {drawGost} from './gost-drawing.ts';
import type {GostPage} from './gost-drawing.ts';
import type {GostReport} from './gost-specification.ts';
let fontPromise:Promise<Uint8Array>|undefined;
async function fontBytes(){return fontPromise??=fetch(new URL('../assets/NotoSans.ttf',import.meta.url)).then(async response=>{if(!response.ok)throw Error('Не удалось загрузить шрифт PDF: '+response.status);return new Uint8Array(await response.arrayBuffer());}).catch(error=>{fontPromise=undefined;throw error;});}
function base64(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
export async function prepareGost(report:GostReport,font?:Uint8Array){
 const {jsPDF}=await import('jspdf');const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a3',compress:true,putOnlyUsedFonts:true});
 doc.addFileToVFS('NotoSans.ttf',base64(font??await fontBytes()));doc.addFont('NotoSans.ttf','NotoSans','normal');doc.setFont('NotoSans');
 const fontMeta=doc.getFont().metadata as unknown as {characterToGlyph:(code:number)=>number};
 const characters=new Set([...report.rows.flatMap(r=>Object.values(r.cells).flatMap(c=>c.state==='value'?[String(c.value??'')]:[])),...Object.values(report.settings.drawing)].join(''));
 const unsupported=[...characters].filter(char=>!/[\s\u0000-\u001f]/.test(char)&&!fontMeta.characterToGlyph(char.codePointAt(0)!));
 if(unsupported.length)throw Error('Шрифт PDF не содержит символы: '+unsupported.slice(0,12).join(' ')+'; исходные значения доступны в JSON/XLSX.');
 const pages=drawGost(report,(value,size)=>{doc.setFontSize(size*72/25.4);return doc.getTextWidth(value);});
 pages.forEach((page,index)=>{if(index)doc.addPage('a3','landscape');for(const c of page.commands){if(c.kind==='line'){doc.setDrawColor(0);doc.setLineWidth(c.width);doc.line(c.x,c.y,c.x2,c.y2);}else{doc.setTextColor(c.muted?120:0);doc.setFontSize(c.size*72/25.4);doc.text(c.text,c.x,c.y,{align:c.align,angle:c.angle??0});}}});
 doc.setProperties({title:report.settings.drawing.title,subject:report.settings.drawing.designation,creator:'Увязка — форма 1 ГОСТ 21.110-2013; основные надписи ГОСТ Р 21.101-2026'});
 return {pages,pdf:()=>new Uint8Array(doc.output('arraybuffer'))};
}
export function gostSvg(page:GostPage):SVGSVGElement{
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 420 297');svg.setAttribute('role','img');svg.setAttribute('aria-label',`Лист ${page.number} спецификации, ${page.footer==='form-3'?'форма 3':'форма 6'}`);
 const bg=document.createElementNS(ns,'rect');bg.setAttribute('width','420');bg.setAttribute('height','297');bg.setAttribute('fill','white');svg.append(bg);
 for(const c of page.commands){const e=document.createElementNS(ns,c.kind==='line'?'line':'text');if(c.kind==='line'){for(const [key,val]of Object.entries({x1:c.x,y1:c.y,x2:c.x2,y2:c.y2,stroke:'#111','stroke-width':c.width}))e.setAttribute(key,String(val));}else{e.setAttribute('x',String(c.x));e.setAttribute('y',String(c.y));e.setAttribute('font-size',String(c.size));e.setAttribute('font-family','UvyazkaNoto, sans-serif');e.setAttribute('fill',c.muted?'#777':'#111');e.setAttribute('text-anchor',c.align==='center'?'middle':c.align==='right'?'end':'start');if(c.angle)e.setAttribute('transform',`rotate(${-c.angle} ${c.x} ${c.y})`);e.textContent=c.text;}svg.append(e);}
 return svg;
}

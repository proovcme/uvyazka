import {copyValue} from './copy-properties.ts';
import {technicalProperty,technicalPropertyGroup} from './ui-language.ts';
const esc=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const labels:Record<string,string>={Other:'Общие', 'Identity Data':'Идентификация',RvtElementRecordGeometry:'Геометрия и размещение',Category:'Категория','Family Name':'Семейство',Family:'Семейство','Family and Type':'Семейство и тип',Type:'Тип','Type Id':'ID типа','Type Name':'Наименование типа',FamilyName:'Семейство',TypeName:'Тип',LevelElementId:'Revit ID уровня',NominalDiameter:'Номинальный диаметр',BoundingBoxHeight:'Высота габарита'};
/** Show engineering fields first, keep unknown serialized fields available on demand. */
export function propertySections(sets:Record<string,Record<string,unknown>>){
 const readable:string[]=[],internal:string[]=[];
 const section=(name:string,rows:[string,unknown][],open:boolean)=>`<details class="property-set"${open?' open':''}><summary>${esc(open?labels[name]??name:name)}</summary><dl>${rows.map(([key,value])=>`<dt>${esc(open?labels[key]??key:key)}</dt><dd>${copyValue(value)}</dd>`).join('')}</dl></details>`;
 for(const [name,values]of Object.entries(sets)){
  const rows=Object.entries(values),technical=technicalPropertyGroup(name);
  const human=technical?[]:rows.filter(([key])=>!technicalProperty(key)),raw=technical?rows:rows.filter(([key])=>technicalProperty(key));
  if(human.length)readable.push(section(name,human,true));if(raw.length)internal.push(section(name,raw,false));
 }
 return readable.join('')+(internal.length?`<details class="ui-diagnostics"><summary>Служебные параметры</summary>${internal.join('')}</details>`:'');
}

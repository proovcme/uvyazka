import type {ModelPackage} from './model';

export type DataSection='elements'|'rooms'|'storeys'|'systems';
export interface DataRow {id:string;name:string;type:string;level:string;record:Record<string,unknown>}
export function rowQuantities(row:DataRow):string{
  const normalized: string[]=[];
  const scan=(value:unknown,path='')=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const obj=value as Record<string,unknown>;
    if('value' in obj&&typeof obj.unit==='string'&&obj.kind==='explicit'){normalized.push(`${path}: ${obj.value} ${obj.unit}`);return;}
    if('value_si' in obj&&typeof obj.value_si==='number'&&typeof obj.unit==='string'){normalized.push(`${path}: ${obj.value_si} ${obj.unit}`);return;}
    for(const [key,next] of Object.entries(obj))scan(next,key);
  };
  scan(row.record.source_quantities??row.record.quantity_sets);
  if(!normalized.length)scan(row.record.quantities);
  return normalized.slice(0,3).join(' · ')||'Явные величины с единицами не прочитаны';
}
export function dataRows(model:ModelPackage,section:DataSection):DataRow[]{
  if(section==='storeys')return model.storeys.map(s=>({id:s.id,name:s.name,type:'IfcBuildingStorey',level:s.elevation_m===null?'Не прочитана':s.elevation_m+' м',record:{...s}}));
  if(section==='systems')return (model.systems??[]).map(s=>({id:s.id,name:s.name||s.class,type:s.class,level:'Участников: '+s.member_ids.length,record:{...s}}));
  const levels=new Map(model.storeys.map(s=>[s.id,s.name]));
  return model.elements.filter(e=>section==='rooms'?e.role==='space':e.role==='element').map(e=>{
    const {mesh,...record}=e;
    return {id:e.id,name:e.long_name?e.name+' · '+e.long_name:e.name,type:e.class,level:levels.get(e.storey_id||'')||'Не прочитан',record:{...record,geometry_available:!!mesh}};
  });
}
export function dataSnapshot(model:ModelPackage,section:DataSection,rows:DataRow[]){
  return {contract:'UvyazkaModelData',version:1,model_id:model.model_id,source:model.source,attribution:model.attribution??null,section,
    coverage:{products:model.statistics.products,physical_elements:model.statistics.physical_elements,rooms:model.elements.filter(e=>e.role==='space').length,
      storeys:model.storeys.length,systems:model.systems?.length??0,geometry_errors:model.statistics.geometry_errors,exported_rows:rows.length},
    interpretation:'Extracted records, not an accepted project passport or verified connections. Explicit quantities and derived mesh measurements remain separate. Missing values are not zero. Raw property-set units may be unavailable.',
    records:rows.map(r=>r.record)};
}
function field(value:unknown){let s=value===null?'null':typeof value==='object'?JSON.stringify(value):String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function parameterCsv(model:ModelPackage,rows:DataRow[]):string{
  const lines:unknown[][]=[['Model ID','Source SHA-256','Entity ID','GlobalId','Name','Path','Value','Unit','Evidence kind']];
  for(const row of rows){
    const hash=(row.record.source as {file_sha256?:string}|undefined)?.file_sha256||model.source.sha256;
    const emit=(path:string,value:unknown,unit='',kind='raw_unreviewed')=>lines.push([model.model_id,hash,row.id,row.record.global_id??'',row.name,path,value,unit,kind]);
    const walk=(path:string,value:unknown)=>{
      if(value&&typeof value==='object'&&!Array.isArray(value)){
        const obj=value as Record<string,unknown>;
        if('value' in obj&&'unit' in obj){emit(path,obj.value,obj.unit==null?'':String(obj.unit),String(obj.kind??'raw_unreviewed'));return;}
        for(const [key,next] of Object.entries(obj))walk(path?path+'.'+key:key,next);
      }else emit(path,value);
    };
    walk('',row.record);
  }
  return '\uFEFF'+lines.map(line=>line.map(field).join(',')).join('\r\n');
}

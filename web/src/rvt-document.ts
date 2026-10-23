import type {ScheduleData} from './rvt-schedule.ts';
export interface NativeObject {class_name:string;fields:Record<string,any>}
export interface NativeRecord {identity:{element_id:number|string;unique_id?:string};class_name:string;kind:'view'|'schedule'|'placement';status:string;diagnostic?:string;source:unknown;graph?:{objects:NativeObject[];edges:{source_object_index:number;pointer_offset:number;target_object_index:number}[]}|null}
export interface RvtDocument {shared_store?:{project_id:string;extraction_id:string;origin:string;source_verification?:string};schedule_data?:ScheduleData;schema_version:number;schema_sha256:string;status:string;error?:string;clipped_records:number;records:NativeRecord[];summary:any;source?:{filename:string;sha256:string;size_bytes:number};evaluated_schedule_body_available:false}
export const fields=(r:NativeRecord)=>r.graph?.objects[0]?.fields??{};
export function identifier(v:any):string|null {if(typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string')return String(v);if(v&&typeof v==='object')return identifier(v.m_id64??v.m_id);return null;}
export function recordName(r:NativeRecord):string {const f=fields(r);return String(f.m_viewName||f.m_viewDescription||`${r.class_name} #${r.identity.element_id}`);}
export function category(r:NativeRecord):string {const f=fields(r);if(r.kind==='placement')return 'placements';if(f.m_isTemplate===true)return 'templates';if(r.kind==='schedule')return 'schedules';if(r.class_name==='DBViewDrafting'&&typeof f.m_sheetNumber==='string'&&f.m_sheetNumber.trim())return 'sheets';if(r.class_name==='DBView3d')return '3d';return ['DBViewPlan','DBViewSection'].includes(r.class_name)?'views':'other';}
export function linked(r:NativeRecord,index:number,p:any):number|null {
  if(!p||typeof p!=='object'||p.pointer_token===0||!Number.isInteger(p.offset))return null;
  const matches=r.graph?.edges.filter(e=>e.source_object_index===index&&e.pointer_offset===p.offset)??[];
  if(matches.length!==1)return null;const target=matches[0].target_object_index;
  return r.graph?.objects[target]?target:null;
}
export function schedule(r:NativeRecord){
  const objects=r.graph?.objects??[],root=fields(r);
  const schemaIndex=linked(r,0,root.m_pSchema),schema=schemaIndex!==null&&objects[schemaIndex].class_name==='ScheduleSchema'?objects[schemaIndex]:null;
  const columns:{order:number;id:string|null;properties:Record<string,any>;path:(string|number)[]}[]=[];
  const cells:{section:unknown;row:number|null;column:number|null;text:string|null;properties:Record<string,any>;path:(string|number)[]}[]=[];
  const issues:string[]=[];
  if(schema&&schemaIndex!==null){
    const pointers=schema.fields.m_pFields??[],ids=schema.fields.m_fieldIds??[];
    pointers.forEach((p:any,i:number)=>{const n=linked(r,schemaIndex,p);if(n===null||objects[n].class_name!=='ScheduleField'){issues.push(`Поле ${i}: ссылка не разрешена`);return;}
      columns.push({order:i,id:ids.length===pointers.length?identifier(ids[i]):null,properties:objects[n].fields,path:['graph','objects',n,'fields']});});
  }else issues.push('Определение таблицы не прочитано');
  const dataIndex=linked(r,0,root.m_pData);
  if(dataIndex!==null&&['ScheduleData','PanelScheduleData','MEPSystemScheduleData'].includes(objects[dataIndex].class_name)){
    for(const p of objects[dataIndex].fields.m_SectionData??[]){const si=linked(r,dataIndex,p);if(si===null){issues.push('Секция таблицы не разрешена');continue;}const section=objects[si].fields;
      for(const row of section.m_tableCells??[]){const ri=linked(r,si,row),nested=ri!==null&&objects[ri].class_name==='TableRowCellData';
        const list=nested?objects[ri!].fields.m_arrCells??[]:Array.isArray(row)?row:[row];
        for(const cell of list){const ci=linked(r,nested?ri!:si,cell);if(ci===null||objects[ci].class_name!=='TableCellData'){issues.push('Ячейка не разрешена');continue;}
          const f=objects[ci].fields;cells.push({section:section.m_index,row:Number.isInteger(f.m_row)?f.m_row:null,column:Number.isInteger(f.m_column)?f.m_column:null,text:typeof f.m_text==='string'?f.m_text:null,properties:f,path:['graph','objects',ci,'fields']});}
      }
    }
  }else issues.push('Сохранённые ячейки недоступны для этой структуры таблицы');
  const rules:{field:string;properties:unknown;path:(string|number)[]}[]=[];
  if(schema&&schemaIndex!==null)for(const key of ['m_filterArr','m_sortFieldArr','m_pEmbeddedSchema']){
    const value=schema.fields[key];for(const pointer of Array.isArray(value)?value:value?[value]:[]){
      const target=linked(r,schemaIndex,pointer);if(target===null){if(pointer?.pointer_token!==0)issues.push(`${key}: ссылка не разрешена`);continue;}
      rules.push({field:key,properties:objects[target].fields,path:['graph','objects',target,'fields']});
    }
  }
  return {columns,cells,issues,rules,schema:schema?.fields??null};
}
export function viewOrientation(r:NativeRecord):{direction:[number,number,number];up:[number,number,number]}|null {
  if(!['DBView3d','DBViewPlan','DBViewSection'].includes(r.class_name)||fields(r).m_isTemplate===true)return null;
  const vector=(x:any):x is [number,number,number]=>Array.isArray(x)&&x.length===3&&x.every(n=>typeof n==='number'&&Number.isFinite(n))&&Math.hypot(...x)>1e-8;
  const f=fields(r),d=f.m_viewDir,u=f.m_vertDir;if(!vector(d)||!vector(u))return null;
  const cross=[d[1]*u[2]-d[2]*u[1],d[2]*u[0]-d[0]*u[2],d[0]*u[1]-d[1]*u[0]];
  return Math.hypot(...cross)>1e-8?{direction:d,up:u}:null;
}
export function sheetPlacements(sheet:NativeRecord,records:NativeRecord[]):NativeRecord[]{
  const drawing=identifier(fields(sheet).m_dbDrawingId),sheetId=String(sheet.identity.element_id);
  return records.filter(r=>{
    if(r.kind!=='placement')return false;const f=fields(r);
    // A sheet's own viewport points back to the sheet. It is not a placed view.
    if(identifier(f.m_dbViewId)===sheetId)return false;
    return identifier(f.m_ownerDBViewId)===sheetId||!!drawing&&drawing!=='-1'&&identifier(f.m_dbDrawingId)===drawing;
  });
}
export function csvCell(v:unknown):string{let text=v==null?'':String(v);if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
export function scheduleCsv(r:NativeRecord):string{return '\ufeff'+[['Секция','Строка (исходная)','Колонка (исходная)','Сохранённый текст','Путь в записи'],...schedule(r).cells.map(c=>[c.section,c.row,c.column,c.text,JSON.stringify(c.path)])].map(row=>row.map(csvCell).join(',')).join('\r\n');}

export type SavedCell=ReturnType<typeof schedule>['cells'][number];
export interface SavedGrid {section:unknown;rows:number[];columns:number[];cells:Map<string,SavedCell[]>;unpositioned:SavedCell[]}
/** Sparse index: no missing cells are invented, duplicate addresses survive. */
export function scheduleGrids(cells:SavedCell[]):SavedGrid[]{
 const groups=new Map<string,SavedGrid>();
 for(const cell of cells){const key=JSON.stringify(cell.section)??'unknown';let grid=groups.get(key);if(!grid){grid={section:cell.section,rows:[],columns:[],cells:new Map(),unpositioned:[]};groups.set(key,grid);}
  if(cell.row===null||cell.column===null||!Number.isSafeInteger(cell.row)||!Number.isSafeInteger(cell.column)||cell.row<0||cell.column<0){grid.unpositioned.push(cell);continue;}
  const address=`${cell.row}:${cell.column}`,existing=grid.cells.get(address)??[];existing.push(cell);grid.cells.set(address,existing);
 }
 for(const grid of groups.values()){const rows=new Set<number>(),columns=new Set<number>();for(const entries of grid.cells.values()){rows.add(entries[0].row!);columns.add(entries[0].column!);}grid.rows=[...rows].sort((a,b)=>a-b);grid.columns=[...columns].sort((a,b)=>a-b);}
 return [...groups.values()];
}
export function savedCellState(cells:SavedCell[]):'missing'|'conflict'|'unreadable'|'empty'|'text'{
 if(!cells.length)return 'missing';if(cells.length>1)return 'conflict';if(cells[0].text===null)return 'unreadable';return cells[0].text===''?'empty':'text';
}

import type {RunState} from './import-journal';
export type FileImportResult={state:Exclude<RunState,'running'>;included:boolean;message:string};
export type BatchItem={name:string;size:number};
export type BatchRow=BatchItem & {state:'waiting'|'running'|FileImportResult['state'];included:boolean;message:string};
export type BatchSnapshot={rows:BatchRow[];finished:boolean;cancelled:boolean;started_at_ms:number;ended_at_ms:number|null};
/** One decoder at a time; only a displayed model advances replacement to append. */
export async function importBatch<T extends BatchItem>(files:readonly T[],open:(file:T,append:boolean)=>Promise<FileImportResult>,options:{append:boolean;signal:AbortSignal;update:(snapshot:BatchSnapshot)=>void}):Promise<BatchSnapshot>{
 const rows:BatchRow[]=files.map(f=>({name:f.name,size:f.size,state:'waiting',included:false,message:''}));
 let added=false;const started_at_ms=Date.now();
 const notify=(finished=false)=>{const value={rows:rows.map(row=>({...row})),finished,cancelled:options.signal.aborted||rows.some(row=>row.state==='cancelled'||row.state==='interrupted'),started_at_ms,ended_at_ms:finished?Date.now():null};options.update(value);return value;};
 notify();
 for(let i=0;i<files.length;i++){
  if(options.signal.aborted)break;
  const row=rows[i];row.state='running';notify();
  try{
   if(!/\.(nwc|nwd|ifc|rvt)$/i.test(row.name))throw Error('В одну 3D-сцену можно добавить NWC, NWD, IFC и RVT. Чертежи открываются отдельно.');
   const result=await open(files[i],options.append||added);row.state=result.state;row.included=result.included;row.message=result.message;added ||= result.included;
  }catch(error){row.state='failed';row.message=error instanceof Error?error.message:String(error);}
  // A cancelled current file stops the queue; ordinary errors do not.
  if(row.state==='cancelled'||row.state==='interrupted')break;
  notify();
 }
 for(const row of rows)if(row.state==='waiting'){row.state='cancelled';row.message='Не запускался: очередь остановлена.';}
 return notify(true);
}
export function batchSummary(batch:BatchSnapshot):string{
 const count=(state:BatchRow['state'])=>batch.rows.filter(row=>row.state===state).length;
 return `Добавлено в сцену: ${batch.rows.filter(row=>row.included).length} из ${batch.rows.length}. Частично прочитано: ${count('partial')}. Ошибок: ${count('failed')}. Отменено: ${count('cancelled')+count('interrupted')}.`;
}

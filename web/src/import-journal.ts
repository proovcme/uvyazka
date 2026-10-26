export type LogLevel = 'info'|'warning'|'error';
export type RunState = 'running'|'completed'|'partial'|'failed'|'cancelled'|'interrupted';
export interface LogEvent {at:string;elapsed_ms:number;level:LogLevel;stage:string;message:string;details?:unknown}
export interface ImportRun {
  id:string;owner:string;operation:'import'|'simulation';filename:string;size_bytes:number;
  sha256?:string;started_at:string;ended_at?:string;state:RunState;stage:string;stage_started_at:string;
  events:LogEvent[];omitted_events:number;warnings:number;errors:number;
}
export interface JournalStorage {load():Promise<ImportRun[]>;save(run:ImportRun):Promise<void>}
const MAX_EVENTS=1000;
export function compactDetails(value:unknown):unknown {
  if(value===undefined)return undefined;
  const json=JSON.stringify(value);
  return json.length<=65536?value:{truncated:true,original_characters:json.length,preview:json.slice(0,65536)};
}
export function filePolicy(name:string,size:number):{error?:string;warning?:string} {
  if(!/\.(ifc|rvt|nwd|dwg|dxf)$/i.test(name)||!Number.isSafeInteger(size)||size<=0)return {error:'Нужен непустой RVT, IFC, NWD, DWG или DXF.'};
  if(/\.nwd$/i.test(name)&&size>512*1024**2)return {error:'NWD: технический бюджет экспериментального читателя — 512 MiB.'};
  if(/\.(dwg|dxf)$/i.test(name)&&size>64*1024*1024)return {error:'CAD-движок поддерживает DWG/DXF до 64 MiB.'};
  if(/\.rvt$/i.test(name)&&size>2*1024**3)return {error:'Размер RVT превышает технический предел текущего читателя: 2 GiB.'};
  return size>64*1024**2?{warning:'Большой файл: обработка может потребовать значительно больше памяти, чем размер файла. Отмена доступна; длительность заранее неизвестна.'}:{};
}
export class ImportJournal {
  runs:ImportRun[]=[];storageError='';
  private pending:Promise<void>=Promise.resolve();
  private dirty=new Map<string,ImportRun>();private saving=false;
  private storage:JournalStorage;private owner:string;private changed:()=>void;private clock:()=>number;
  constructor(storage:JournalStorage,owner:string,changed:()=>void=()=>{},clock:()=>number=Date.now){
    this.storage=storage;this.owner=owner;this.changed=changed;this.clock=clock;
  }
  async restore(){
    try {
      this.runs=await this.storage.load();
      for(const run of this.runs)if(run.owner===this.owner&&run.state==='running')
        this.finish(run,'interrupted','Предыдущая сессия завершилась без результата. Причина неизвестна: вкладка могла быть закрыта или перезапущена.');
    }catch(error){this.storageError='История недоступна: '+String(error);}
    this.changed();
  }
  begin(operation:ImportRun['operation'],filename:string,size_bytes:number):ImportRun {
    const at=new Date(this.clock()).toISOString();
    const run:ImportRun={id:crypto.randomUUID(),owner:this.owner,operation,filename,size_bytes,started_at:at,state:'running',stage:'Подготовка',stage_started_at:at,events:[],omitted_events:0,warnings:0,errors:0};
    this.runs.unshift(run);this.event(run,'info','Запуск обработки',{size_bytes});return run;
  }
  event(run:ImportRun,level:LogLevel,message:string,details?:unknown){
    if(run.state!=='running')return;
    const stamp=this.clock();
    run.events.push({at:new Date(stamp).toISOString(),elapsed_ms:Math.max(0,stamp-Date.parse(run.started_at)),level,stage:run.stage,message,details:compactDetails(details)});
    if(level==='warning')run.warnings++;if(level==='error')run.errors++;
    if(run.events.length>MAX_EVENTS){run.events.splice(1,1);run.omitted_events++;}
    this.persist(run);
  }
  progress(run:ImportRun,stage:string,message:string,details?:unknown){
    if(run.state!=='running')return;
    if(stage!==run.stage){
      this.event(run,'info','Этап завершён',{stage:run.stage,duration_ms:Math.max(0,this.clock()-Date.parse(run.stage_started_at))});
      run.stage=stage;run.stage_started_at=new Date(this.clock()).toISOString();
    }
    this.event(run,'info',message,details);
  }
  source(run:ImportRun,sha256:string){run.sha256=sha256;this.event(run,'info','Контрольная сумма исходного файла',{sha256});}
  finish(run:ImportRun,state:Exclude<RunState,'running'>,message:string,details?:unknown){
    if(run.state!=='running')return;
    this.event(run,state==='failed'?'error':state==='completed'?'info':'warning',message,
      {stage_duration_ms:Math.max(0,this.clock()-Date.parse(run.stage_started_at)),result:details});
    run.state=state;run.ended_at=new Date(this.clock()).toISOString();this.persist(run);
  }
  private persist(run:ImportRun){
    // Coalesce writes while IndexedDB is busy instead of queuing hundreds of full snapshots.
    this.dirty.set(run.id,run);
    if(!this.saving){
      this.saving=true;
      this.pending=this.pending.then(async()=>{
        while(this.dirty.size){
          const [id,next]=this.dirty.entries().next().value!;this.dirty.delete(id);
          try{await this.storage.save(structuredClone(next));}
          catch(error){this.storageError='Журнал не сохранён на диск браузера: '+String(error)+'. Скачайте JSON или TXT.';this.changed();}
        }
      }).finally(()=>{this.saving=false;});
    }
    this.changed();
  }
  flush(){return this.pending;}
}
export function textReport(run:ImportRun):string {
  return [`${run.filename} · ${run.operation} · ${run.state}`,`ID: ${run.id}`,`Размер: ${run.size_bytes} bytes`,
    `SHA-256: ${run.sha256||'не вычислен'}`,`Начало: ${run.started_at}`,`Конец: ${run.ended_at||'в процессе'}`,
    `Предупреждения: ${run.warnings}; ошибки: ${run.errors}; вытеснено событий: ${run.omitted_events}`,
    ...run.events.map(e=>`${e.at} +${(e.elapsed_ms/1000).toFixed(2)}s [${e.level}] ${e.stage}: ${e.message}${e.details===undefined?'':'\n'+JSON.stringify(e.details,null,2)}`)].join('\n');
}
export function browserJournalStorage():JournalStorage {
  const database=new Promise<IDBDatabase>((resolve,reject)=>{
    const req=indexedDB.open('uvyazka-processing-journal',1);
    req.onupgradeneeded=()=>{const store=req.result.createObjectStore('runs',{keyPath:'id'});store.createIndex('started_at','started_at');};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(Error('Хранилище заблокировано другой вкладкой'));
  });
  return {
    async load(){const db=await database;return new Promise((resolve,reject)=>{
      const result:ImportRun[]=[];const tx=db.transaction('runs');const req=tx.objectStore('runs').index('started_at').openCursor(null,'prev');
      req.onsuccess=()=>{const cursor=req.result;if(cursor&&result.length<30){result.push(cursor.value);cursor.continue();}else resolve(result);};
      req.onerror=()=>reject(req.error);
    });},
    async save(run){const db=await database;await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('runs','readwrite');tx.objectStore('runs').put(run);
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Запись отменена'));
    });}
  };
}

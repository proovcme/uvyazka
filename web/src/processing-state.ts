import type {RunState} from './import-journal';
export const stagesFor=(filename:string,simulation=false)=>simulation?['Подготовка','Расчёт','Отображение']:/\.(dwg|dxf)$/i.test(filename)?['Чтение файла','CAD']:/\.nwd$/i.test(filename)?['Чтение файла','Хеширование','NWD-движок','Данные NWD','Геометрия','Отображение']:['Чтение файла','Хеширование',...(/\.rvt$/i.test(filename)?['RVT-движок','Документ RVT','Параметры RVT','Связи RVT','RVT → IFC','IFC-буфер']:[]),'IFC-движок','Структура IFC','Свойства IFC','Геометрия','Отображение'];
export type StepState='waiting'|'active'|'done'|'skipped'|'stopped';
export class ProcessingState {
  startedAt=0;stageAt=0;lastReply=0;lastUpdate=0;stage='';message='';filename='';size=0;state:RunState='running';
  steps:{name:string;state:StepState}[]=[];
  begin(filename:string,size:number,now:number,simulation=false){this.filename=filename;this.size=size;this.startedAt=this.stageAt=this.lastUpdate=now;this.lastReply=0;this.stage='Подготовка';this.message='Подготовка файла';this.state='running';this.steps=stagesFor(filename,simulation).map(name=>({name,state:'waiting'}));}
  update(stage:string,message:string,now:number){
    if(this.state!=='running')return;
    if(stage!==this.stage){for(const step of this.steps)if(step.state==='active')step.state='done';this.stage=stage;this.stageAt=now;}
    const index=this.steps.findIndex(s=>s.name===stage);
    if(index>=0){this.steps.forEach((s,i)=>{if(i<index&&s.state==='waiting')s.state='skipped';});this.steps[index].state='active';}
    this.message=message;this.lastUpdate=now;
  }
  reply(now:number){if(this.state==='running')this.lastReply=now;}
  finish(state:Exclude<RunState,'running'>,message:string,now:number){if(this.state!=='running')return;this.state=state;this.message=message;this.lastUpdate=now;for(const step of this.steps)if(step.state==='active')step.state=state==='completed'?'done':'stopped';}
  snapshot(now:number){
    const end=this.state==='running'?now:this.lastUpdate,age=Math.max(0,now-Math.max(this.lastReply,this.lastUpdate));
    return {elapsed:Math.max(0,end-this.startedAt),stageElapsed:Math.max(0,end-this.stageAt),silent:age>=15000,replyAge:this.lastReply?Math.max(0,now-this.lastReply):null};
  }
}
export function duration(ms:number){const seconds=Math.floor(ms/1000);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}

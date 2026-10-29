import type {RunState} from './import-journal';
import type {RvtMode} from './browser-rvt-direct';
export function stagesFor(filename:string,simulation=false,rvtMode:RvtMode='ifc'){
  if(simulation)return ['Подготовка','Расчёт','Отображение'];
  if(/\.(dwg|dxf)$/i.test(filename))return ['Чтение файла','CAD'];
  const steps=['Чтение файла','Хеширование'];
  if(/\.(nwd|nwc)$/i.test(filename))return [...steps,'NWD-движок','Данные NWD','Геометрия','Отображение'];
  if(/\.rvt$/i.test(filename)){
    steps.push('Проверка формата','RVT-движок','Документ RVT','Параметры RVT','Связи RVT');
    if(rvtMode==='direct')return [...steps,'RVT напрямую','Сцена RVT','Отображение'];
    steps.push('RVT → IFC','IFC-буфер');
  }
  return [...steps,'IFC-движок','Структура IFC','Свойства IFC','Геометрия','Отображение'];
}
export type StepState='waiting'|'active'|'done'|'skipped'|'stopped';
export class ProcessingState {
  startedAt=0;stageAt=0;lastReply=0;lastUpdate=0;stage='';message='';filename='';size=0;state:RunState='running';
  steps:{name:string;state:StepState}[]=[];
  begin(filename:string,size:number,now:number,simulation=false,rvtMode:RvtMode='ifc'){this.filename=filename;this.size=size;this.startedAt=this.stageAt=this.lastUpdate=now;this.lastReply=0;this.stage='Подготовка';this.message='Подготовка файла';this.state='running';this.steps=stagesFor(filename,simulation,rvtMode).map(name=>({name,state:'waiting'}));}
  update(stage:string,message:string,now:number){
    if(this.state!=='running')return;
    if(!this.steps.some(step=>step.name===stage)){
      const active=this.steps.findIndex(step=>step.state==='active');
      const waiting=this.steps.findIndex(step=>step.state==='waiting');
      this.steps.splice(active>=0?active+1:waiting>=0?waiting:this.steps.length,0,{name:stage,state:'waiting'});
    }
    if(stage!==this.stage){for(const step of this.steps)if(step.state==='active')step.state='done';this.stage=stage;this.stageAt=now;}
    const index=this.steps.findIndex(s=>s.name===stage);
    if(index>=0){this.steps.forEach((s,i)=>{if(i<index&&s.state==='waiting')s.state='skipped';});this.steps[index].state='active';}
    this.message=message;this.lastUpdate=now;
  }
  reply(now:number){if(this.state==='running')this.lastReply=now;}
  finish(state:Exclude<RunState,'running'>,message:string,now:number){if(this.state!=='running')return;this.state=state;this.message=message;this.lastUpdate=now;for(const step of this.steps){if(step.state==='active')step.state=state==='completed'||state==='partial'&&step.name==='Отображение'?'done':'stopped';else if(step.state==='waiting')step.state='skipped';}}
  snapshot(now:number){
    const end=this.state==='running'?now:this.lastUpdate,age=Math.max(0,now-Math.max(this.lastReply,this.lastUpdate));
    return {elapsed:Math.max(0,end-this.startedAt),stageElapsed:Math.max(0,end-this.stageAt),silent:age>=15000,replyAge:this.lastReply?Math.max(0,now-this.lastReply):null};
  }
}
export function duration(ms:number){const seconds=Math.floor(ms/1000);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}

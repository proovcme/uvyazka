import type { Point, Lease } from './site-motion';

export type WorkerPhase = 'idle' | 'waiting' | 'approach' | 'climb' | 'work' | 'depart' | 'blocked';
export type WorkerTool = 'hammer' | 'trowel' | 'wrench' | 'pliers' | 'hose' | 'meter' | 'probe';
export interface WorkerRoute { points: Point[]; modes: ('walk'|'climb')[]; basis: string[] }
export interface WorkerTask {
  operationId:string; targetId:string|null; targetName:string; contact:Point;
  home:Point; destination:Point; route:WorkerRoute; start:number; end:number;
  approachMinutes:number; approachStart:number; workStart:number; workEnd:number;
  tool:WorkerTool; action:string; blocked:string|null;
}
export const distance=(a:Point,b:Point)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const mix=(a:Point,b:Point,t:number)=>a.map((v,i)=>v+(b[i]-v)*t) as Point;

export function taskAction(kind:string):{tool:WorkerTool;action:string} {
  if(/concret|blinding/.test(kind))return {tool:'hose',action:'укладка и уплотнение смеси'};
  if(/reinforc/.test(kind))return {tool:'pliers',action:'вязка арматуры'};
  if(/formwork|stripping/.test(kind))return {tool:'hammer',action:kind==='stripping'?'разборка опалубки':'крепление опалубки'};
  if(/masonry|waterproof/.test(kind))return {tool:'trowel',action:'нанесение и разравнивание слоя'};
  if(/inspect|check|survey|setting_out|as_built|commission/.test(kind))return {tool:'meter',action:'осмотр и замер'};
  if(/duct|pipe|mep|lifting|install|scaffold/.test(kind))return {tool:'wrench',action:'установка и крепление элемента'};
  return {tool:'probe',action:'подготовка рабочего участка'};
}

export function routeMinutes(route:WorkerRoute) {
  return route.modes.map((mode,i)=>distance(route.points[i],route.points[i+1])/(mode==='climb'?8:60));
}
export function makeWorkerTask(lease:Lease, home:Point, destination:Point, contact:Point, targetId:string|null,targetName:string,route:WorkerRoute,reason:string|null=null):WorkerTask {
  const approachMinutes=routeMinutes(route).reduce((a,b)=>a+b,0);
  const blocked=reason ?? (approachMinutes*2+.1>lease.end-lease.start?'В интервале назначения не хватает времени на подход, работу и возвращение.':null);
  return {operationId:lease.operation.id,targetId,targetName,home,destination,contact,route,start:lease.start,end:lease.end,
    approachMinutes,approachStart:lease.start,workStart:lease.start+approachMinutes,workEnd:lease.end-approachMinutes,
    ...taskAction(lease.operation.kind),blocked};
}
export function sampleWorkerTask(task:WorkerTask,tick:number,member=0) {
  let phase:WorkerPhase='idle',position:Point=task.home,direction:Point=[0,0,1],travelled=0;
  if(tick>=task.start&&tick<task.end) {
    if(task.blocked)phase='blocked';
    else if(tick<task.approachStart)phase='waiting';
    else if(tick>=task.workStart&&tick<task.workEnd){phase='work';position=task.destination;direction=task.contact.map((v,i)=>v-position[i]) as Point;}
    else {
      const departing=tick>=task.workEnd;
      let remaining=departing?task.end-tick:tick-task.approachStart;
      const durations=routeMinutes(task.route);
      for(let i=0;i<durations.length;i++) {
        const a=task.route.points[i],b=task.route.points[i+1];
        if(remaining<=durations[i]+1e-9 || i===durations.length-1) {
          const fraction=Math.min(1,remaining/Math.max(durations[i],1e-9));position=mix(a,b,fraction);travelled+=distance(a,b)*fraction;
          direction=(departing?a.map((v,j)=>v-b[j]):b.map((v,j)=>v-a[j])) as Point;
          phase=task.route.modes[i]==='climb'?'climb':departing?'depart':'approach';break;
        }
        remaining-=durations[i];travelled+=distance(a,b);
      }
    }
  }
  const work=phase==='work', moving=['approach','depart','climb'].includes(phase);
  const cycle=work?(tick-task.workStart)/Math.min(.6,Math.max(.025,(task.workEnd-task.workStart)/4))+member*.3:travelled/.7;
  const stroke=Math.sin(cycle*Math.PI*2);
  const arm=work?(task.tool==='meter'?-.85+stroke*.12:task.tool==='hose'?-.8+stroke*.15:task.tool==='hammer'?-.9+stroke*.6:-.9+stroke*.25):moving?stroke*.5:0;
  return {phase,position,direction,travelled,arm,walk:moving?stroke*.45:0,lean:work?(task.tool==='trowel'||task.tool==='pliers'?.35:.1):0,
    action:phase==='work'?task.action:({idle:'нет назначения',waiting:'ожидание свободного прохода',approach:'подход к месту',climb:'подъём / спуск по лестнице',depart:'возвращение',blocked:'доступ заблокирован'} as Record<string,string>)[phase],
    progress:work?(tick-task.workStart)/(task.workEnd-task.workStart):tick>=task.workEnd&&!task.blocked?1:0};
}

export function taskSegments(task:WorkerTask) {
  const segments:{start:number;end:number;a:Point;b:Point}[]=[];
  if(task.blocked)return [{start:task.start,end:task.end,a:task.home,b:task.home}];
  if(task.approachStart>task.start)segments.push({start:task.start,end:task.approachStart,a:task.home,b:task.home});
  const durations=routeMinutes(task.route);let time=task.approachStart;
  durations.forEach((d,i)=>{segments.push({start:time,end:time+d,a:task.route.points[i],b:task.route.points[i+1]});time+=d;});
  segments.push({start:task.workStart,end:task.workEnd,a:task.destination,b:task.destination});time=task.workEnd;
  for(let i=durations.length-1;i>=0;i--){segments.push({start:time,end:time+durations[i],a:task.route.points[i+1],b:task.route.points[i]});time+=durations[i];}
  return segments.filter(s=>s.end>s.start);
}
/** Continuous closest approach over piecewise linear motion, including ladder occupancy. */
export function tasksConflict(a:WorkerTask,b:WorkerTask) {
  if(a.start>=b.end||b.start>=a.end)return false;
  for(const s of taskSegments(a))for(const t of taskSegments(b)) {
    let lo=Math.max(s.start,t.start),hi=Math.min(s.end,t.end);if(lo>=hi)continue;
    const velocity=s.b.map((v,i)=>(v-s.a[i])/(s.end-s.start)-(t.b[i]-t.a[i])/(t.end-t.start));
    const relative=(time:number)=>s.a.map((v,i)=>v+(s.b[i]-v)*(time-s.start)/(s.end-s.start)-(t.a[i]+(t.b[i]-t.a[i])*(time-t.start)/(t.end-t.start)));
    const p=relative(lo);
    if(Math.abs(velocity[1])<1e-9){if(Math.abs(p[1])>=1.75)continue;}
    else {const y1=lo+(-1.75-p[1])/velocity[1],y2=lo+(1.75-p[1])/velocity[1];lo=Math.max(lo,Math.min(y1,y2));hi=Math.min(hi,Math.max(y1,y2));if(lo>=hi)continue;}
    const q=relative(lo),speed=velocity[0]**2+velocity[2]**2;
    const at=speed<1e-12?lo:Math.max(lo,Math.min(hi,lo-(q[0]*velocity[0]+q[2]*velocity[2])/speed));
    const d=relative(at);if(Math.hypot(d[0],d[2])<.58)return true;
  }
  return false;
}

export function reserveWorkerTask(task:WorkerTask,prior:WorkerTask[]):WorkerTask|null {
  if(task.blocked)return task;
  for(const delay of [0,.1,.25,.5,1,2,4]) {
    const candidate={...task,approachStart:task.start+delay,workStart:task.workStart+delay};
    if(candidate.workStart+.1>candidate.workEnd)continue;
    if(!prior.some(p=>tasksConflict(candidate,p)))return candidate;
  }
  return null;
}

export interface NavigationWorld {
  minX:number;maxX:number;minZ:number;maxZ:number;
  surface:(x:number,z:number)=>number|null;
  clear:(point:Point)=>boolean;
}
/** Local support and body clearance are tested along every edge, not just at endpoints. */
export function walkEdge(a:Point,b:Point,world:NavigationWorld) {
  const count=Math.max(1,Math.ceil(distance(a,b)/.15));let previous=a[1];
  for(let i=0;i<=count;i++) {
    const p=mix(a,b,i/count),height=world.surface(p[0],p[2]);
    if(height===null||Math.abs(height-previous)>.2||Math.abs(height-p[1])>.2||!world.clear([p[0],height,p[2]]))return false;
    previous=height;
  }
  return true;
}
/** Deterministic bounded A*, no diagonal corner cutting or unsupported shortcuts. */
export function findWalkRoute(start:Point,goal:Point,world:NavigationWorld,step=.6,maxNodes=12000):Point[]|null {
  if(!walkEdge(start,start,world)||!walkEdge(goal,goal,world))return null;
  if(walkEdge(start,goal,world))return [start,goal];
  type Node={x:number;z:number;p:Point;g:number;f:number;parent:Node|null};
  const initial:Node={x:0,z:0,p:start,g:0,f:distance(start,goal),parent:null};
  const open=[initial],best=new Map<string,number>([['0,0',0]]);
  let visited=0;
  while(open.length&&visited++<maxNodes) {
    let index=0;for(let i=1;i<open.length;i++)if(open[i].f<open[index].f)index=i;
    const current=open.splice(index,1)[0];
    if(current.g>best.get(`${current.x},${current.z}`)!+1e-8)continue;
    if(distance(current.p,goal)<step*1.5&&walkEdge(current.p,goal,world)) {
      const path:Point[]=[goal];let n:Node|null=current;while(n){path.push(n.p);n=n.parent;}path.reverse();
      const result:Point[]=[path[0]];let anchor=0;
      while(anchor<path.length-1){let last=path.length-1;while(last>anchor+1&&!walkEdge(path[anchor],path[last],world))last--;result.push(path[last]);anchor=last;}
      return result;
    }
    for(const [dx,dz] of [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]]) {
      const x=current.x+dx,z=current.z+dz,px=start[0]+x*step,pz=start[2]+z*step;
      if(px<world.minX||px>world.maxX||pz<world.minZ||pz>world.maxZ)continue;
      const y=world.surface(px,pz);if(y===null)continue;
      const p:Point=[px,y,pz],g=current.g+distance(current.p,p),key=`${x},${z}`;
      if(g>=(best.get(key)??Infinity)-1e-8||!walkEdge(current.p,p,world))continue;
      best.set(key,g);open.push({x,z,p,g,f:g+distance(p,goal),parent:current});
    }
  }
  return null;
}

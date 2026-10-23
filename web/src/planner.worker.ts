const worker=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(value:unknown)=>void};
let python:any;
worker.onmessage=async({data})=>{
  if(data.kind==='ping'){worker.postMessage({job:data.job,kind:'pong'});return;}
  const {job,base,model,scenario,variant='base',curingDays=28,capacityFactor=1}=data;
  try {
    if(!python){
      worker.postMessage({job,kind:'progress',text:'Загрузка Python для расчёта на вашем устройстве'});
      const {loadPyodide}=await import(/* @vite-ignore */base+'runtime/pyodide/pyodide.mjs');
      python=await loadPyodide({indexURL:base+'runtime/pyodide/'});
      const response=await fetch(base+'runtime/planner.zip');if(!response.ok)throw Error('Не загружен планировщик');
      python.unpackArchive(await response.arrayBuffer(),'zip',{extractDir:'/home/pyodide'});
    }
    worker.postMessage({job,kind:'progress',text:'Расчёт работ, зависимостей и ожиданий ресурсов'});
    python.globals.set('request_json',JSON.stringify({model,scenario,variant,curingDays,capacityFactor}));
    const prepared=JSON.parse(await python.runPythonAsync(`
import json
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.simulation import SimulationEngine
from uvyazka.construction.critical_path import cpm
request=json.loads(request_json)
scenario=request.get('scenario') or build_scenario(request['model'], request['variant'], concrete_curing_days=request['curingDays'])
if len(scenario['operations'])>20000:
    raise ValueError('Браузерный предел: 20 000 работ; используйте локальный расчёт')
factor=request['capacityFactor']
if type(factor) is not int or not 1<=factor<=4:
    raise ValueError('Множитель ресурсов должен быть целым от 1 до 4')
if factor!=1:
    for resource in scenario['resources']:
        resource['capacity']*=factor
    scenario['assumptions'].append(f'Доступность каждого ресурса увеличена в {factor} раз; производительность одной назначенной бригады не изменена')
scenario.update(project_id='browser-local',revision=1)
engine=SimulationEngine(scenario)
json.dumps({'total':len(scenario['operations'])})
`));
    while(true){
      const progress=JSON.parse(await python.runPythonAsync(`
for _batch_index in range(200):
    if not engine.step():break
json.dumps({'more':bool(engine.queue),'completed':sum(s['status']=='completed' for s in engine.states.values())})
`));
      worker.postMessage({job,kind:'progress',text:`Расчёт: завершено ${progress.completed} / ${prepared.total} работ`});
      if(!progress.more)break;
      // Yield the worker event loop: heartbeat replies stay available during large runs.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const result=await python.runPythonAsync(`
result=engine.run()
result.update(project_id='browser-local',cpm=cpm(scenario))
json.dumps(result,ensure_ascii=False,allow_nan=False)
`);
    const run=JSON.parse(result);
    python.globals.delete('request_json');
    await python.runPythonAsync('del request, scenario, result, engine, _batch_index\nimport gc\ngc.collect()');
    worker.postMessage({job,kind:'planned',run});
  }catch(error){worker.postMessage({job,kind:'error',message:error instanceof Error?error.message:String(error)});}
};
export {};

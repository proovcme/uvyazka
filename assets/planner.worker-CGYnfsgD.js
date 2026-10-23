(function(){let e=self,t;e.onmessage=async({data:n})=>{if(n.kind===`ping`){e.postMessage({job:n.job,kind:`pong`});return}let{job:r,base:i,model:a,scenario:o,variant:s=`base`,curingDays:c=28,capacityFactor:l=1}=n;try{if(!t){e.postMessage({job:r,kind:`progress`,text:`Загрузка Python для расчёта на вашем устройстве`});let{loadPyodide:n}=await import(
/* @vite-ignore */
i+`runtime/pyodide/pyodide.mjs`);t=await n({indexURL:i+`runtime/pyodide/`});let a=await fetch(i+`runtime/planner.zip`);if(!a.ok)throw Error(`Не загружен планировщик`);t.unpackArchive(await a.arrayBuffer(),`zip`,{extractDir:`/home/pyodide`})}e.postMessage({job:r,kind:`progress`,text:`Расчёт работ, зависимостей и ожиданий ресурсов`}),t.globals.set(`request_json`,JSON.stringify({model:a,scenario:o,variant:s,curingDays:c,capacityFactor:l}));let n=JSON.parse(await t.runPythonAsync(`
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
`));for(;;){let i=JSON.parse(await t.runPythonAsync(`
for _batch_index in range(200):
    if not engine.step():break
json.dumps({'more':bool(engine.queue),'completed':sum(s['status']=='completed' for s in engine.states.values())})
`));if(e.postMessage({job:r,kind:`progress`,text:`Расчёт: завершено ${i.completed} / ${n.total} работ`}),!i.more)break;await new Promise(e=>setTimeout(e,0))}let u=await t.runPythonAsync(`
result=engine.run()
result.update(project_id='browser-local',cpm=cpm(scenario))
json.dumps(result,ensure_ascii=False,allow_nan=False)
`),d=JSON.parse(u);t.globals.delete(`request_json`),await t.runPythonAsync(`del request, scenario, result, engine, _batch_index
import gc
gc.collect()`),e.postMessage({job:r,kind:`planned`,run:d})}catch(t){e.postMessage({job:r,kind:`error`,message:t instanceof Error?t.message:String(t)})}}})();
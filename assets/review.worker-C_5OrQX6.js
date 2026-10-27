(function(){let e=self,t;e.onmessage=async({data:n})=>{let{id:r,base:i,kind:a}=n;try{if(!t){e.postMessage({id:r,kind:`progress`,text:`Загрузка локального движка проверок`});let{loadPyodide:n}=await import(
/* @vite-ignore */
i+`runtime/pyodide/pyodide.mjs`);t=await n({indexURL:i+`runtime/pyodide/`});let a=await fetch(i+`runtime/planner.zip`);if(!a.ok)throw Error(`Не загружено ядро проверок`);t.unpackArchive(await a.arrayBuffer(),`zip`,{extractDir:`/home/pyodide`})}if(t.globals.set(`review_request`,JSON.stringify(a===`run`?{model:n.model,rule:n.rule}:{report:n.report,views:n.views??{},format:n.format,version:n.version??`3.0`})),a===`run`){t.FS.writeFile(`/tmp/review-geometry.bin`,new Uint8Array(n.binary)),t.globals.set(`review_progress`,t=>e.postMessage({id:r,kind:`progress`,...JSON.parse(t)}));let i=await t.runPythonAsync(`
import json
from pathlib import Path
from uvyazka.construction.clashes import run_clashes
request=json.loads(review_request)
sent_issues=0
def emit(report):
    global sent_issues
    meta={k:v for k,v in report.items() if k not in ('issues','contacts')}
    review_progress(json.dumps({'coverage':report['coverage'],'found':len(report['issues']),'partial':meta,'issues_delta':report['issues'][sent_issues:]}))
    sent_issues=len(report['issues'])
result=run_clashes(request['model'],Path('/tmp/review-geometry.bin').read_bytes(),request['rule'],emit)
json.dumps(result,ensure_ascii=False,allow_nan=False)
`);t.FS.unlink(`/tmp/review-geometry.bin`),e.postMessage({id:r,kind:`result`,report:JSON.parse(i)})}else{let n=await t.runPythonAsync(`
import json,base64
from uvyazka.construction.clash_export import bcf,xlsx
request=json.loads(review_request)
output=bcf(request['report'],request['views'],request['version']) if request['format']=='bcf' else xlsx(request['report'])
base64.b64encode(output).decode('ascii')
`);e.postMessage({id:r,kind:`export`,data:n})}t.globals.delete(`review_request`),await t.runPythonAsync(`request=None
result=None
output=None
import gc
gc.collect()`)}catch(t){e.postMessage({id:r,kind:`error`,message:t instanceof Error?t.message:String(t)})}}})();
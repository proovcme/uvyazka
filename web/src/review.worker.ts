const scope=self as unknown as {onmessage:((e:MessageEvent)=>void)|null;postMessage:(value:unknown)=>void};
let python:any;
scope.onmessage=async({data})=>{
 const {id,base,kind}=data;
 try{
  if(!python){scope.postMessage({id,kind:'progress',text:'Загрузка локального движка проверок'});const {loadPyodide}=await import(/* @vite-ignore */base+'runtime/pyodide/pyodide.mjs');python=await loadPyodide({indexURL:base+'runtime/pyodide/'});const r=await fetch(base+'runtime/planner.zip');if(!r.ok)throw Error('Не загружено ядро проверок');python.unpackArchive(await r.arrayBuffer(),'zip',{extractDir:'/home/pyodide'});}
  python.globals.set('review_request',JSON.stringify(kind==='run'?{model:data.model,rule:data.rule}:{report:data.report,views:data.views??{},format:data.format,version:data.version??'3.0'}));
  if(kind==='run'){
   python.FS.writeFile('/tmp/review-geometry.bin',new Uint8Array(data.binary));
   python.globals.set('review_progress',(json:string)=>scope.postMessage({id,kind:'progress',...JSON.parse(json)}));
   const raw=await python.runPythonAsync(`
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
`);
   python.FS.unlink('/tmp/review-geometry.bin');scope.postMessage({id,kind:'result',report:JSON.parse(raw)});
  }else{
   const raw=await python.runPythonAsync(`
import json,base64
from uvyazka.construction.clash_export import bcf,xlsx
request=json.loads(review_request)
output=bcf(request['report'],request['views'],request['version']) if request['format']=='bcf' else xlsx(request['report'])
base64.b64encode(output).decode('ascii')
`);scope.postMessage({id,kind:'export',data:raw});
  }
  python.globals.delete('review_request');await python.runPythonAsync('request=None\nresult=None\noutput=None\nimport gc\ngc.collect()');
 }catch(error){scope.postMessage({id,kind:'error',message:error instanceof Error?error.message:String(error)});}
};
export {};

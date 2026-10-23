"""Verify complete public demo downloads from the client, including hashes and timings.

This is a network/data check, not a visual browser or clipboard acceptance test.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import re
import time
from urllib.parse import urljoin
from urllib.request import Request,urlopen

def fetch(base,name,timeout):
    started=time.perf_counter()
    with urlopen(Request(urljoin(base,name),headers={'Accept-Encoding':'gzip','User-Agent':'uvyazka-delivery-check/1'}),timeout=timeout) as response:
        first=time.perf_counter();raw=response.read();encoding=response.headers.get('Content-Encoding','identity')
        body=gzip.decompress(raw) if encoding=='gzip' else raw
        if encoding not in {'identity','gzip'}:raise ValueError('Unexpected content encoding: '+encoding)
    return body,{'path':name,'wire_bytes':len(raw),'decoded_bytes':len(body),'first_byte_seconds':round(first-started,3),'seconds':round(time.perf_counter()-started,3)}

def check(base,timeout=20,revision=None,large=False,all_models=False):
    base=base.rstrip('/')+'/'
    manifest=json.loads(fetch(base,'release.json',timeout)[0])
    if manifest['mode']!='browser-compute-and-public-examples':raise ValueError('Unexpected demo release')
    if revision and manifest['revision']!=revision:raise ValueError('Unexpected deployed revision')
    digests=manifest['files_sha256'];results=[]
    def verified(name):
        raw,measurement=fetch(base,name,timeout)
        if hashlib.sha256(raw).hexdigest()!=digests[name]:raise ValueError('Incomplete or modified download: '+name)
        return raw,measurement
    html,measurement=verified('index.html');results.append(measurement)
    names=[]
    for url in re.findall(r'(?:src|href)="([^"]+\.(?:js|css))"',html.decode('utf-8')):
        name=url.removeprefix('/uvyazka/').removeprefix('./');names.append(name)
    if large or all_models:
        models,measurement=verified('demo/models.json');results.append(measurement)
        examples,measurement=verified('demo/examples.json');results.append(measurement)
        selected=json.loads(models)['items'] if all_models else json.loads(models)['items'][:1]
        rvt=next(e for e in json.loads(examples)['items'] if e['kind']=='rvt')
        for model in selected:
            mid=model['model_id'];names.extend(['demo/model-'+mid+'.json','demo/geometry-'+mid+'.bin'])
        names.extend([rvt['url'],
            'runtime/rvt/uvyazka_rvt_browser_bg.wasm','runtime/web-ifc/web-ifc.wasm',
            'runtime/pyodide/pyodide.asm.wasm','runtime/planner.zip','cad/index.html'])
    names=list(dict.fromkeys(names))
    with ThreadPoolExecutor(max_workers=4) as pool:
        for _,measurement in pool.map(verified,names):results.append(measurement)
    return {'url':base,'revision':manifest['revision'],'verification':'complete HTTP bodies and SHA-256, not browser visual acceptance','downloads':results}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url',nargs='?',default='https://locia.work/uvyazka/')
    parser.add_argument('--revision');parser.add_argument('--timeout',type=float,default=20)
    parser.add_argument('--large',action='store_true',help='Also fetch model, geometry, RVT and compute runtimes')
    parser.add_argument('--all-models',action='store_true',help='Verify every catalogued model, including the federation')
    args=parser.parse_args()
    print(json.dumps(check(args.url,args.timeout,args.revision,args.large,args.all_models),ensure_ascii=False,indent=2))

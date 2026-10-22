"""Exercise real file selection, workers and planner parity on a served demo.

Requires playwright and Chrome (or its bundled Chromium). Pass public fixture
paths; reports stay in ignored build storage, never inside the published site.
"""
import argparse
import json
from pathlib import Path
import sys
import time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from uvyazka.construction.simulation import SimulationEngine
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.critical_path import cpm

def wait_expression(page,expression,timeout=300000):
    # Playwright wait_for_function internally uses eval, blocked by our real CSP.
    deadline=time.monotonic()+timeout/1000
    while time.monotonic()<deadline:
        if page.evaluate(expression):return
        time.sleep(.15)
    raise TimeoutError(page.locator('#browser-status').inner_text())

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8778/uvyazka/')
    parser.add_argument('--channel',default='chrome')
    parser.add_argument('--serve',action='store_true',help='Start a local preview with production CSP on port 8779')
    parser.add_argument('--out',type=Path,default=ROOT/'.uvyazka-build/browser-verification')
    parser.add_argument('files',type=Path,nargs='+')
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    if args.serve:
        import threading
        from http.server import ThreadingHTTPServer
        from serve_browser_demo import Handler
        server=ThreadingHTTPServer(('127.0.0.1',8779),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        args.url='http://127.0.0.1:8779/uvyazka/'
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(channel=args.channel,headless=True,args=['--enable-unsafe-swiftshader'])
        for path in args.files:
            context=browser.new_context(accept_downloads=True,viewport={'width':1440,'height':1000})
            requests=[];errors=[];page=context.new_page()
            page.on('request',lambda req:requests.append({'method':req.method,'url':req.url,'bytes':len(req.post_data_buffer or b'')}))
            page.on('pageerror',lambda err:errors.append(str(err)))
            page.on('console',lambda msg:print('CONSOLE',msg.type,msg.text[:300]) if msg.type=='error' else None)
            page.add_init_script('''
              window.__results=[];
              const OriginalWorker=window.Worker;
              window.Worker=class extends OriginalWorker {
                constructor(...args){super(...args);this.addEventListener('message',e=>{
                  if(['imported','planned','error'].includes(e.data.kind))window.__results.push(e.data);
                });}
              };
            ''')
            page.goto(args.url,wait_until='networkidle')
            page.locator('#canvas[data-render-ready=true]').wait_for()
            start=time.monotonic()
            page.locator('#browser-file').set_input_files(path)
            wait_expression(page,"window.__results.some(x=>x.kind==='imported'||x.kind==='error')",timeout=300000)
            status=page.locator('#browser-status').inner_text();print(path.name,status,flush=True)
            imported=page.evaluate("JSON.parse(JSON.stringify(window.__results.find(x=>x.kind==='imported')?.model || null))")
            if imported is None:
                results.append({'file':path.name,'error':status});context.close();continue
            imported_seconds=time.monotonic()-start
            (args.out/(path.name+'.model.json')).write_text(json.dumps(imported,ensure_ascii=False),encoding='utf-8')
            page.locator('#conversion-done').wait_for(state='visible', timeout=300000)
            page.locator('#conversion-done').click()
            assert page.locator('html').get_attribute('data-theme') == 'light'
            page.locator('#theme-toggle').click()
            assert page.locator('html').get_attribute('data-theme') == 'dark'
            page.locator('#theme-toggle').click()
            page.locator('#mode-simulate').click()
            page.locator('#file-settings').click()
            page.locator('#browser-plan').click()
            wait_expression(page,"window.__results.some(x=>x.kind==='planned'||x.kind==='error')",timeout=300000)
            planned=page.evaluate("window.__results.find(x=>x.kind==='planned')?.run || null")
            if planned is None:
                results.append({'file':path.name,'import':imported['statistics'],'error':page.locator('#browser-status').inner_text()});context.close();continue
            native_scenario=build_scenario(imported,'base');native_scenario.update(project_id='browser-local',revision=1)
            expected=SimulationEngine(native_scenario).run();expected.update(project_id='browser-local',cpm=cpm(native_scenario))
            # Both independently build the scenario from the exact imported evidence.
            assert expected==planned, f'{path.name}: CPython/Pyodide discrepancy'
            assert not errors,errors
            assert all(r['method']=='GET' and r['bytes']==0 and r['url'].startswith(args.url.split('/uvyazka/')[0]) for r in requests),requests
            page.locator('#conversion-done').wait_for(state='visible', timeout=300000)
            page.locator('#conversion-done').click()
            page.locator('#play').click();page.wait_for_timeout(350);page.locator('#play').click()
            assert page.locator('#error').is_hidden(),page.locator('#error').inner_text()
            # Reuse the loaded Python worker with the network disabled.
            context.set_offline(True)
            page.locator('#file-settings').click()
            page.locator('#browser-capacity').select_option('2')
            page.locator('#browser-plan').click()
            wait_expression(page,"window.__results.filter(x=>x.kind==='planned').length===2 || window.__results.some(x=>x.kind==='error')",timeout=60000)
            offline=page.evaluate("window.__results.filter(x=>x.kind==='planned')[1]?.run || null")
            assert offline is not None,page.locator('#browser-status').inner_text()
            scenario2=build_scenario(imported,'base')
            for resource in scenario2['resources']:resource['capacity']*=2
            scenario2['assumptions'].append('Доступность каждого ресурса увеличена в 2 раз; производительность одной назначенной бригады не изменена')
            scenario2.update(project_id='browser-local',revision=1)
            expected2=SimulationEngine(scenario2).run();expected2.update(project_id='browser-local',cpm=cpm(scenario2))
            assert expected2==offline,f'{path.name}: offline recomputation differs'
            page.locator('#conversion-done').wait_for(state='visible', timeout=60000)
            page.locator('#conversion-done').click()
            context.set_offline(False)
            page.locator('.view-options > summary').click()
            page.locator('#site').uncheck()
            page.locator('.view-options > summary').click()
            page.locator('#fit').click()
            page.locator('#canvas').scroll_into_view_if_needed()
            page.screenshot(path=str(args.out/(path.name+'.png')),full_page=False)
            results.append({'file':path.name,'source_sha256':imported['source']['sha256'],'import':imported['statistics'],'bounds':[imported['coordinate_system']['bounds_min_m'],imported['coordinate_system']['bounds_max_m']],
                'import_seconds':round(imported_seconds,2),'total_seconds':round(time.monotonic()-start,2),'operations':len(planned['scenario']['operations']),'duration_minutes':planned['duration'],'unplanned_elements':len(planned['scenario']['unplanned_element_ids']),
                'cpython_pyodide_exact_match':True,'offline_recalculation_exact_match':True,'model_upload_requests':0,'external_requests':0,'errors':errors})
            print(json.dumps(results[-1]),flush=True)
            context.close()
        browser.close()
    (args.out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    if any('error' in row for row in results):raise SystemExit(1)

if __name__=='__main__':main()

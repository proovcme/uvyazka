"""Pinned public IFC/RVT examples, attribution and data; no private project inputs."""
from pathlib import Path
import hashlib
import json
import shutil
from urllib.request import urlopen

from uvyazka.construction.importer import import_model, IMPORTER_VERSION
from uvyazka.construction.federation import create_federation

ROOT = Path(__file__).resolve().parents[1]


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')


def prepare():
    config = json.loads((ROOT/'tools/public-demo-sources.json').read_text(encoding='utf-8'))
    cache = ROOT/'.uvyazka-build/public-model-cache'
    sources = cache/'sources'; sources.mkdir(parents=True, exist_ok=True)
    for item in config['files']:
        path = sources/item['name']
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            # Reuse only hash-matching public fixtures; arbitrary local paths are never inputs.
            fixtures = [ROOT/'.uvyazka-build/demo-models/clinic'/item['name'], ROOT/'.uvyazka-build/browser-fixtures'/item['name']]
            local = next((p for p in fixtures if p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256']),None)
            if local: shutil.copyfile(local,path)
            else:
                with urlopen(item['url'],timeout=90) as response: path.write_bytes(response.read())
        assert path.stat().st_size==item['size'] and hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256'],item['name']
        if item['kind']=='ifc':
            output = cache/'models'/item['sha256']; manifest=output/'manifest.json'
            if not manifest.is_file() or json.loads(manifest.read_text(encoding='utf-8'))['importer_version']!=IMPORTER_VERSION:
                print('Importing public example:',item['name'],flush=True)
                import_model(str(path),str(output),item['name'])
    return config,cache


def export(destination):
    config,cache=prepare(); catalog=[]
    existing=json.loads((destination/'models.json').read_text(encoding='utf-8'))['items']
    names={'Clinic_Architectural.ifc':'Клиника · архитектура и помещения','Clinic_HVAC.ifc':'Клиника · вентиляция','Clinic_Electrical.ifc':'Клиника · электрика'}
    for item in config['files']:
        if item['kind']!='ifc':continue
        mid=item['sha256']; source=cache/'models'/mid
        pkg=json.loads((source/'manifest.json').read_text(encoding='utf-8'))
        pkg['project_id']='demo-a';pkg['attribution']={**config['clinic'],'transformations':'IFC tessellated to ModelPackage; units normalized where explicit; derived mesh measurements separately labelled. No engineering acceptance.'}
        write(destination/f'model-{mid}.json',pkg)
        shutil.copyfile(source/'geometry.bin',destination/f'geometry-{mid}.bin')
        catalog.append({'model_id':mid,'name':names[item['name']],'statistics':pkg['statistics'],'spaces':sum(e['role']=='space' for e in pkg['elements'])})
    # A federation retains separate source IDs and does not assert coordinate alignment.
    members=[{'model_id':i['sha256'],'instance_id':key,'label':label} for i,key,label in zip(config['files'][:3],['ar','el','ov'],['АР','ЭОМ','ОВ'])]
    result=create_federation(cache,members);mid=result['model_id'];source=cache/'models'/mid
    pkg=json.loads((source/'manifest.json').read_text(encoding='utf-8'));pkg['project_id']='demo-a'
    pkg['source']['filename']='Medical-Dental Clinic · АР + ОВ + ЭОМ';pkg['attribution']=config['clinic']
    write(destination/f'model-{mid}.json',pkg);shutil.copyfile(source/'geometry.bin',destination/f'geometry-{mid}.bin')
    catalog.append({'model_id':mid,'name':'Клиника · сводная АР + ОВ + ЭОМ','statistics':pkg['statistics']})
    write(destination/'models.json',{'items':catalog+existing})
    examples=[{'id':c['model_id'],'kind':'model','name':c['name']} for c in catalog+existing]
    for item in config['files']:
        if item['kind']!='rvt':continue
        shutil.copyfile(cache/'sources'/item['name'],destination/item['name'])
        with urlopen(item['license_url'],timeout=30) as response:(destination/'IFC-ECS-LICENSE.txt').write_bytes(response.read())
        examples.append({'id':'rvt-re1','kind':'rvt','name':'RVT · инженерия RE1 · открыть декодером','url':'demo/'+item['name'],'sha256':item['sha256'],'size':item['size']})
    write(destination/'examples.json',{'items':examples,'default':catalog[0]['model_id']})
    write(destination/'sources.json',config)
    (destination/'ATTRIBUTION.txt').write_text('BSI (2020) "Medical-Dental Test Files," buildingSMART International\nhttps://github.com/buildingsmart-community/Community-Sample-Test-Files/tree/7ddf57a201f88a0c213d5322b02ed15e94a60a40\nCC BY 4.0 — https://creativecommons.org/licenses/by/4.0/\nChanges: IFC tessellation, separate mesh measurements, federation with source IDs. Original IFC sources unchanged.\nRE1 RVT: Drshelden/IFC-ECS, MIT; see IFC-ECS-LICENSE.txt.\n',encoding='utf-8')
    print(json.dumps({'public_models':catalog,'rvt_example':True},ensure_ascii=False),flush=True)


if __name__=='__main__':prepare()

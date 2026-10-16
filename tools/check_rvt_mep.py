"""Compare native and converted MEP membership with pinned public RE1 exports.

Requires IfcOpenShell. --fetch downloads the MIT IFC-ECS samples into ignored
local build storage. Models are never committed. An absent fixture is a failure.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from uvyazka.construction.rvt_runtime import binary_path

BASE='https://raw.githubusercontent.com/Drshelden/IFC-ECS/9e8b37175a0fba1397f7011aeee917fe52de7623/data/RE1/'
HASHES={
    'RE1-Mechanical.rvt':'d559720177aa0ec435133f804e7c45d60da2deb9d5585bb3d55f4830139c014b',
    'RE1-Mechanical.ifc':'9e56cf7246ce86ef73646dd588a1efb8a4756e5e102b30e28b3b58577a454db0',
    'RE1-Plumbing.rvt':'03689df2aa426031a216e65051b9f19d3265d6fe96884dd47373b17435f9e54c',
    'RE1-Plumbing.ifc':'294490b222632509779910345f27a4eeda3645956138a593298c241495f7b8b6',
    'RE1-Electrical.rvt':'9875e765c9f47893808c47b845a8379b8777b92510e3e0284f763cb457c9630b',
    'RE1-Electrical.ifc':'c7002a10c8e10ab2fca64ff61dcf38db04da652924f65ce53c2064827dfa9e16',
}
SYSTEM_CLASSES=['RbsHvacSystem','RbsPipingSystem','RbsElectricalSystem']

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def ifc_data(path):
    import ifcopenshell
    model=ifcopenshell.open(str(path))
    ids={str(e.Tag) for e in model.by_type('IfcElement') if e.Tag is not None}
    systems=[(s.Name,{str(e.Tag) for relation in s.IsGroupedBy for e in relation.RelatedObjects
        if e.is_a('IfcElement') and e.Tag is not None}) for s in model.by_type('IfcSystem')]
    return ids,systems

def key(systems,allowed):
    # Circuit numbers repeat across panels: compare a multiset of name + members.
    return Counter((name,tuple(sorted(members&allowed))) for name,members in systems)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch',action='store_true')
    parser.add_argument('--directory',type=Path,default=ROOT/'.uvyazka-build/rvt-mep-audit')
    args=parser.parse_args();folder=args.directory;folder.mkdir(parents=True,exist_ok=True)
    for name,expected in HASHES.items():
        path=folder/name
        if not path.exists() and args.fetch:
            with urlopen(BASE+name,timeout=90) as response:path.write_bytes(response.read())
        if not path.is_file() or digest(path)!=expected:
            raise RuntimeError(f'Missing or changed pinned fixture: {name}; use --fetch for missing files')
    request=folder/'systems-request.json'
    request.write_text(json.dumps({'mode':'records','classes':SYSTEM_CLASSES,'max_records':20000}),encoding='utf-8')
    results=[]
    for discipline,expected_count in [('Mechanical',5),('Plumbing',8),('Electrical',13)]:
        source=folder/f'RE1-{discipline}.rvt';records=folder/f'{discipline}-systems.ndjson'
        subprocess.run([str(binary_path('ifccs-rvt-metadata')),'--extract',str(source),str(request),str(records)],check=True,timeout=180)
        report=json.loads(records.with_suffix('.summary.json').read_text(encoding='utf-8'))
        rows=[json.loads(line) for line in records.read_text(encoding='utf-8').splitlines()]
        assert not report['error'] and report['mep_projection_errors']==0,report.get('error')
        assert len(rows)==expected_count,(discipline,len(rows))
        reference_ids,reference=ifc_data(folder/f'RE1-{discipline}.ifc')
        projected=[(r['mep_system']['name'],set(map(str,r['mep_system']['members']))) for r in rows]
        assert key(projected,reference_ids)==key(reference,reference_ids),(discipline,'native membership differs')
        target=folder/f'{discipline}-converted.ifc';diagnostics=folder/f'{discipline}-converted.json'
        subprocess.run([str(binary_path('rvt-ifc')),str(source),'-o',str(target),'--mode','geometry','--diagnostics',str(diagnostics)],check=True,timeout=300,capture_output=True)
        output_ids,output=ifc_data(target);common=reference_ids&output_ids
        assert common,(discipline,'empty geometry population')
        assert key(output,common)==key(reference,common),(discipline,'converted membership differs')
        export_report=json.loads(diagnostics.read_text(encoding='utf-8'))
        assert not any(w.startswith('RVT_MEP:') for w in export_report['warnings']),export_report['warnings']
        assert digest(source)==HASHES[source.name],'Source RVT changed'
        results.append({'discipline':discipline,'systems':len(rows),
            'reference_memberships':sum(len(m) for _,m in reference),
            'native_matches_all_reference_memberships':True,'converted_matches_common_elements':True,
            'reference_elements_not_exported':len(reference_ids-output_ids),
            'base_equipment_references':sum(e['role']=='base_equipment_reference' for r in rows for e in r['mep_system']['member_evidence'])})
    (folder/'verification.json').write_text(json.dumps({'source_commit':BASE.split('/')[5],'results':results},indent=2),encoding='utf-8')
    print(json.dumps(results,ensure_ascii=False,indent=2))

if __name__=='__main__':main()

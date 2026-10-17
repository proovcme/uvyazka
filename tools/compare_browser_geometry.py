"""Compare browser extraction with native IFC and RVT exports on public fixtures."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from uvyazka.construction.importer import import_model
from uvyazka.construction.rvt_runtime import binary_path

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reports',type=Path,default=ROOT/'.uvyazka-build/browser-verification')
    parser.add_argument('files',type=Path,nargs='+')
    args=parser.parse_args();results=[]
    for source in args.files:
        observed=json.loads((args.reports/(source.name+'.model.json')).read_text(encoding='utf8'))
        native_root=args.reports/(source.name+'.native');native_root.mkdir(exist_ok=True)
        path=source
        if source.suffix.lower()=='.rvt':
            path=native_root/'converted.ifc'
            subprocess.run([str(binary_path('rvt-ifc')),str(source),'-o',str(path),'--mode','geometry','--saved-meshes'],check=True,capture_output=True,timeout=300)
        try:
            import_model(str(path),str(native_root))
        except ValueError as error:
            result={'file':source.name,'native_import_blocked':True,'reason':str(error),
                'browser_bounds':[observed['coordinate_system']['bounds_min_m'],observed['coordinate_system']['bounds_max_m']]}
            results.append(result);print(json.dumps(result),flush=True);continue
        native=json.loads((native_root/'manifest.json').read_text(encoding='utf8'))
        a={e['global_id']:e for e in observed['elements'] if e['role']=='element'}
        b={e['global_id']:e for e in native['elements'] if e['role']=='element'}
        assert set(a)==set(b),(source.name,'element population differs',set(a)^set(b))
        differing_class=[k for k in a if a[k]['class']!=b[k]['class']]
        assert not differing_class,(source.name,differing_class)
        import ifcopenshell
        from collections import Counter
        reference=ifcopenshell.open(str(path))
        expected_systems=Counter((s.Name or '',tuple(sorted(e.GlobalId for rel in s.IsGroupedBy for e in rel.RelatedObjects if e.is_a('IfcElement') and not e.is_a('IfcFeatureElement')))) for s in reference.by_type('IfcSystem'))
        by_step={e['id']:e for e in observed['elements']}
        actual_systems=Counter((s['name'],tuple(sorted(by_step[k]['global_id'] for k in s['member_ids']))) for s in observed.get('systems',[]))
        assert expected_systems==actual_systems,(source.name,'system membership differs')
        bounds=[];geometry_mismatch=[];quantity_eligibility_mismatch=[]
        for key in sorted(a):
            x,y=a[key],b[key]
            if bool(x['mesh'])!=bool(y['mesh']):geometry_mismatch.append(key)
            if x.get('geometry_evidence',{}).get('quantity_eligible')!=y.get('geometry_evidence',{}).get('quantity_eligible'):quantity_eligibility_mismatch.append(key)
            if x['mesh'] and y['mesh']:
                delta=max(abs(x['mesh'][side][i]-y['mesh'][side][i]) for side in ['bbox_min_m','bbox_max_m'] for i in range(3))
                bounds.append((delta,key))
        max_delta=max((d for d,_ in bounds),default=None)
        result={'file':source.name,'physical_elements':len(a),'global_ids_and_classes_match':True,'systems_and_membership_match':True,'systems':sum(actual_systems.values()),'mesh_presence_differences':geometry_mismatch,
            'maximum_bbox_difference_m':max_delta,'bbox_differences_over_1cm':[{'global_id':k,'delta_m':d} for d,k in bounds if d>.01],
            'quantity_eligibility_differences':quantity_eligibility_mismatch,
            'note':'1 cm is a diagnostic threshold for tessellation comparisons; differences are retained, not treated as approved engineering geometry.'}
        results.append(result);print(json.dumps(result),flush=True)
    (args.reports/'geometry-comparison.json').write_text(json.dumps(results,indent=2),encoding='utf8')

if __name__=='__main__':main()

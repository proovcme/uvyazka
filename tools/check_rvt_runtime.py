"""Smoke-test built native tools using a generated CFB, never a real model."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from uvyazka.construction.rvt_runtime import binary_path,binary_name

if __name__=='__main__':
    converter=binary_path('rvt-ifc'); info=binary_path('rvt-info'); reader=binary_path('ifccs-rvt-metadata')
    generators=[ROOT/'.uvyazka-build/rvt-target'/profile/binary_name('gen-fixture') for profile in ['release','debug']]
    generator=next((p for p in generators if p.is_file()),None)
    if not generator: raise SystemExit('Build with tools/setup_rvt.py --with-fixture-generator first')
    with tempfile.TemporaryDirectory() as directory:
        root=Path(directory); source=root/'synthetic.rvt'
        subprocess.run([str(generator),'uvyazka-smoke','--classes','Wall,Level,Project,Column','--element-count','20','--output',str(source)],check=True,capture_output=True)
        before=source.read_bytes()
        metadata=json.loads(subprocess.check_output([str(info),str(source),'--json'],text=True,encoding='utf-8'))
        assert metadata['version']==2024 and metadata['class_name_count']>=4
        request=root/'request.json';inventory=root/'inventory.json';records=root/'records.ndjson'
        request.write_text(json.dumps({'mode':'inventory'}),encoding='utf-8')
        catalog_result=subprocess.run([str(reader),'--extract',str(source),str(request),str(inventory)],capture_output=True,text=True,encoding='utf-8')
        if catalog_result.returncode==0:
            catalog=json.loads(inventory.read_text(encoding='utf-8'))
            assert catalog['schema_version']==1 and len(catalog['classes'])>=4
        else:
            # gen-fixture uses the older simplified schema parser, not the
            # full forward grammar required by current-record extraction.
            assert catalog_result.stderr.strip() and not inventory.exists()
        request.write_text(json.dumps({'mode':'records','max_records':20}),encoding='utf-8')
        records_result=subprocess.run([str(reader),'--extract',str(source),str(request),str(records)],capture_output=True,text=True,encoding='utf-8')
        if records_result.returncode==0:
            report=json.loads(records.with_suffix('.summary.json').read_text(encoding='utf-8'))
            assert report['schema_version']==1 and report['value_semantics']=='serialized_not_evaluated'
            assert report['status']=='partial' and report['error'],report
        else:
            assert records_result.stderr.strip() and not records.exists()
        ids=root/'ids.json';ids.write_text('[]',encoding='utf-8'); output=root/'phases.json'
        phases=subprocess.run([str(reader),str(source),str(ids),str(output)],capture_output=True,text=True,encoding='utf-8')
        # The fixture has no native ADocument graph. A bounded explicit failure
        # is correct; fabricated phases would be a regression.
        if phases.returncode==0:
            assert json.loads(output.read_text(encoding='utf-8'))['schema_version']==1
        else:
            assert phases.stderr.strip() and not output.exists(),phases.stderr
        diagnostics=root/'diagnostics.json'; ifc=root/'converted.ifc'
        result=subprocess.run([str(converter),str(source),'-o',str(ifc),'--mode','geometry','--saved-meshes','--diagnostics',str(diagnostics)],capture_output=True,text=True,encoding='utf-8')
        # This hand-built CFB has metadata but no valid building geometry.
        # A successful empty IFC would be a regression, not a passing conversion.
        assert result.returncode!=0 and not ifc.exists(),result.stdout+result.stderr
        assert json.loads(diagnostics.read_text(encoding='utf-8'))['schema_version']==1
        assert before==source.read_bytes()
    print('Native RVT smoke passed: metadata, bounded unsupported schema/records/phase-reader responses, geometry rejection and unchanged source')

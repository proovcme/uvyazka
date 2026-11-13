"""Synthetic CAD conversion checks; no proprietary runtime in the repository."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.cad_conversion import CADConversions,configure,converter_status
from uvyazka.core import Workspace,digest
from uvyazka.ingest import scan

try:
    import ezdxf
except ImportError:
    ezdxf=None


def synthetic(path):
    doc=ezdxf.new('R2018');doc.units=4
    doc.styles.new('Example',dxfattribs={'font':'example-font.ttf'})
    doc.layers.new('Network',dxfattribs={'true_color':0x123456})
    symbol=doc.blocks.new('ExampleSwitch');symbol.add_line((0,0),(4,8));symbol.add_attdef('CODE',(4,4),height=3)
    ref=doc.modelspace().add_blockref('ExampleSwitch',(100,200),dxfattribs={'layer':'Network'})
    ref.add_auto_attribs({'CODE':'Тест №7'})
    doc.modelspace().add_lwpolyline([(0,0),(100,100),(400,100)])
    doc.modelspace().add_mtext('Синтетический пример',dxfattribs={'style':'Example','insert':(0,30),'char_height':3})
    doc.modelspace().add_circle((50,60),8)
    lo=doc.layouts.new('Example sheet');lo.page_setup(size=(420,297))
    lo.add_viewport(center=(150,140),size=(200,180),view_center_point=(100,100),view_height=9000,dxfattribs={'flags':16384})
    doc.saveas(path)


class ConfigurationTests(unittest.TestCase):
    def test_explicit_installation_missing_and_changed_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);home=root/'state';home.mkdir()
            self.assertFalse(converter_status(home)['available'])
            exe=root/'ODAFileConverter.exe';exe.write_bytes(b'synthetic executable, not run')
            dll=root/'engine.dll';dll.write_bytes(b'synthetic dependency')
            configure(home,exe,'synthetic')
            self.assertTrue(converter_status(home)['available'])
            dll.write_bytes(b'changed dependency')
            self.assertFalse(converter_status(home)['available'])
            script=root/'script.py';script.write_text('synthetic script, not run')
            with self.assertRaises(ValueError):configure(home,script)

    def test_server_registers_optional_tools_without_running_converter(self):
        from uvyazka.server import build_server
        with tempfile.TemporaryDirectory() as temp:
            ws=Workspace(temp)
            with patch('uvyazka.cad_conversion.run_converter') as run:
                server=build_server(ws)
                names={t.name for t in asyncio.run(server.list_tools())}
                self.assertTrue({'cad_converter_status','convert_cad_document','get_cad_conversion'}<=names)
                asyncio.run(server.call_tool('cad_converter_status',{}))
                run.assert_not_called()


@unittest.skipIf(ezdxf is None,'optional ezdxf not installed')
class FidelityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.a=self.root/'a.dxf';self.b=self.root/'b.dxf';synthetic(self.a);shutil.copyfile(self.a,self.b)

    def compare(self):
        from uvyazka.cad_fidelity import compare_dxf
        return compare_dxf(self.a,self.b)

    def test_identity_and_material_changes(self):
        self.assertTrue(self.compare()['passed'])
        for change in ['geometry','attribute','font','viewport_scale','missing_block_entity','rgb','polyline']:
            with self.subTest(change=change):
                d=ezdxf.readfile(self.a)
                if change=='geometry':next(iter(d.blocks['ExampleSwitch'])).dxf.end=(8,8)
                elif change=='attribute':d.modelspace().query('INSERT').first.attribs[0].dxf.text='Changed'
                elif change=='font':d.styles.get('Example').dxf.font='different.ttf'
                elif change=='viewport_scale':d.layouts.get('Example sheet').query('VIEWPORT').first.dxf.view_height=4500
                elif change=='missing_block_entity':d.blocks['ExampleSwitch'].delete_entity(next(iter(d.blocks['ExampleSwitch'])))
                elif change=='rgb':d.layers.get('Network').dxf.true_color=0x654321
                elif change=='polyline':d.modelspace().query('LWPOLYLINE').first.set_points([(0,0),(101,100),(400,100)])
                d.saveas(self.b);self.assertFalse(self.compare()['passed'])

    def test_no_pass_for_unsupported_geometry(self):
        d=ezdxf.readfile(self.a);d.modelspace().add_hatch();d.saveas(self.a);shutil.copyfile(self.a,self.b)
        r=self.compare();self.assertFalse(r['passed']);self.assertIn('HATCH',r['unsupported_entities'])

    def test_extension_dictionary_is_not_silently_approved(self):
        d=ezdxf.readfile(self.a);d.modelspace().query('INSERT').first.new_extension_dict();d.saveas(self.a);shutil.copyfile(self.a,self.b)
        r=self.compare();self.assertFalse(r['passed']);self.assertIn('ENTITY_EXTENSION_DICTIONARY',r['unsupported_entities'])

    def test_visible_tab_order_and_block_insert_transform(self):
        d=ezdxf.readfile(self.a);d.layouts.new('Another sheet');d.saveas(self.a)
        d.layouts.get('Example sheet').dxf.taborder=10;d.saveas(self.b)
        self.assertFalse(self.compare()['passed'])
        d=ezdxf.readfile(self.a);d.modelspace().query('INSERT').first.dxf.xscale=2;d.saveas(self.b)
        self.assertFalse(self.compare()['passed'])

    def test_identical_truecolor_retains_explicit_aci_diagnostic(self):
        d=ezdxf.readfile(self.a);d.layers.get('Network').dxf.color=42;d.saveas(self.b)
        r=self.compare();self.assertTrue(r['passed']);self.assertEqual(r['normalizations']['aci_fallback_changed_with_identical_rgb'],1)
        d.layers.get('Network').dxf.color=-42;d.saveas(self.b);self.assertFalse(self.compare()['passed'])


@unittest.skipIf(ezdxf is None,'optional ezdxf not installed')
class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);root=Path(self.temp.name)
        self.source=root/'sources';self.source.mkdir();self.input=self.source/'synthetic.dxf';synthetic(self.input)
        self.ws=Workspace(root/'state');self.ws.create_project('one','Synthetic CAD',self.source);scan(self.ws,'one')
        self.doc=self.ws.find_documents('one')['documents'][0]['doc_id'];self.service=CADConversions(self.ws)
        self.exe=root/'ODAFileConverter.exe';self.exe.write_bytes(b'synthetic executable, not run');configure(self.ws.home,self.exe)
        self.original=digest(self.input)

    def fake(self,exe,src,dst,version,fmt,filename):
        if fmt=='DWG':(Path(dst)/'drawing.dwg').write_bytes(b'AC1032synthetic output')
        else:shutil.copyfile(self.input,Path(dst)/'drawing.dxf')
        return {'returncode':0,'stdout':'','stderr':''}

    def convert(self,request='one'):
        return self.service.convert('one',self.doc,request)

    def test_source_readonly_persistence_idempotence_and_scoping(self):
        with patch('uvyazka.cad_conversion.run_converter',side_effect=self.fake) as run:
            first=self.convert();self.assertEqual(first['status'],'converted_checked');self.assertEqual(run.call_count,2)
            again=self.convert();self.assertEqual(first['conversion_id'],again['conversion_id']);self.assertEqual(run.call_count,2)
            self.assertEqual(digest(self.input),self.original)
            self.assertTrue(CADConversions(self.ws).get('one',first['conversion_id'])['current_source_matches'])
            self.ws.create_project('two','Another synthetic CAD',self.source)
            with self.assertRaises(ValueError):self.service.get('two',first['conversion_id'])
            with self.assertRaises(ValueError):self.service.convert('one',self.doc,'one',version='ACAD2013')
        self.input.write_text('changed source',encoding='utf8')
        self.assertFalse(self.service.get('one',first['conversion_id'])['current_source_matches'])
        with self.assertRaisesRegex(ValueError,'scan'):self.convert('fresh')

    def test_failure_is_retained_and_not_silently_retried(self):
        for error in [subprocess.TimeoutExpired(['synthetic'],120),RuntimeError('synthetic engine failure')]:
            with self.subTest(error=type(error).__name__),patch('uvyazka.cad_conversion.run_converter',side_effect=error) as run:
                key=type(error).__name__;first=self.convert(key)
                self.assertEqual(first['status'],'failed');self.assertEqual(first['artifacts'],[])
                self.assertEqual(self.convert(key)['conversion_id'],first['conversion_id']);self.assertEqual(run.call_count,1)
                self.assertEqual(digest(self.input),self.original)

    def test_checker_revision_is_pinned_and_staleness_is_visible(self):
        with patch('uvyazka.cad_conversion.run_converter',side_effect=self.fake):r=self.convert()
        self.assertTrue(r['current_validation_matches'])
        with patch('uvyazka.cad_fidelity.checker_revision',return_value='changed-checker'):
            self.assertFalse(self.service.get('one',r['conversion_id'])['current_validation_matches'])

    def test_invalid_file_version_and_changed_roundtrip_do_not_pass(self):
        def wrong(exe,src,dst,version,fmt,filename):
            if fmt=='DWG':(Path(dst)/'drawing.dwg').write_bytes(b'AC1015wrong version')
            return {'returncode':0,'stdout':'','stderr':''}
        with patch('uvyazka.cad_conversion.run_converter',side_effect=wrong):self.assertEqual(self.convert('wrong')['status'],'failed')
        def corrupt(exe,src,dst,version,fmt,filename):
            result=self.fake(exe,src,dst,version,fmt,filename)
            if fmt=='DXF':
                path=Path(dst)/'drawing.dxf';d=ezdxf.readfile(path);d.styles.get('Example').dxf.font='wrong.ttf';d.saveas(path)
            return result
        with patch('uvyazka.cad_conversion.run_converter',side_effect=corrupt):
            r=self.convert('corrupt');self.assertEqual(r['status'],'converted_needs_review');self.assertFalse(r['validation']['passed'])

    def test_artifact_tampering_and_unsafe_options(self):
        with patch('uvyazka.cad_conversion.run_converter',side_effect=self.fake):r=self.convert()
        Path(r['artifacts'][0]['path']).write_bytes(b'changed output')
        with self.assertRaisesRegex(ValueError,'artifact'):self.service.get('one',r['conversion_id'])
        with self.assertRaises(ValueError):self.service.convert('one',self.doc,'format',output_format='DWG; shell')
        with self.assertRaises(ValueError):self.service.convert('one','../not-a-doc','traversal')

    def test_dwg_to_dxf_never_claims_binary_equivalence(self):
        source=self.source/'synthetic.dwg';source.write_bytes(b'AC1032synthetic source');scan(self.ws,'one')
        doc=next(x['doc_id'] for x in self.ws.find_documents('one')['documents'] if x['relative_path'].endswith('.dwg'))
        with patch('uvyazka.cad_conversion.run_converter',side_effect=self.fake):
            r=self.service.convert('one',doc,'decode','DXF');self.assertEqual(r['status'],'converted_unverified');self.assertFalse(r['validation']['passed'])


@unittest.skipUnless(ezdxf is not None and os.environ.get('UVYAZKA_TEST_ODA'),'set external ODA path for a real synthetic integration test')
class ExternalODATests(unittest.TestCase):
    def test_actual_synthetic_conversion(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';source.mkdir();synthetic(source/'synthetic.dxf')
            ws=Workspace(root/'state');ws.create_project('one','Synthetic ODA integration',source);scan(ws,'one')
            configure(ws.home,os.environ['UVYAZKA_TEST_ODA'])
            doc=ws.find_documents('one')['documents'][0]['doc_id']
            r=CADConversions(ws).convert('one',doc,'external')
            self.assertEqual(r['status'],'converted_checked',r)

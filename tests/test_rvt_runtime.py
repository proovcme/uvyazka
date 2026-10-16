import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from uvyazka.construction.rvt_runtime import NAMES, UPSTREAM_REVISION, binary_name, binary_path, converter_status, sha256


class RuntimeTests(unittest.TestCase):
    def test_managed_runtime_integrity_and_rejected_active_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            home=Path(directory); runtime=home/'tools/rvt'; key='a'*64
            folder=runtime/'releases'/key; folder.mkdir(parents=True)
            for name in NAMES: (folder/binary_name(name)).write_bytes(('synthetic executable placeholder '+name).encode())
            manifest={'schema_version':1,'release':key,'upstream_revision':UPSTREAM_REVISION,
                'binaries':{name:sha256(folder/binary_name(name)) for name in NAMES}}
            (folder/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
            active=runtime/'active.json'; active.write_text(json.dumps({'schema_version':1,'release':key}),encoding='utf-8')
            status=converter_status(home)
            self.assertTrue(status['available']); self.assertTrue(status['phase_reader_available'])
            self.assertEqual(status['binaries']['rvt-ifc']['source_revision'],UPSTREAM_REVISION)
            (folder/binary_name('rvt-ifc')).write_bytes(b'changed executable')
            self.assertFalse(converter_status(home)['available'])
            with self.assertRaises(ValueError): binary_path('rvt-ifc',home)
            active.write_text(json.dumps({'schema_version':1,'release':'../escape'}),encoding='utf-8')
            self.assertFalse(converter_status(home)['available'])

    def test_explicit_converter_and_reader_overrides_remain_unverified(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            converter=root/binary_name('rvt-ifc'); converter.write_bytes(b'fixture')
            info=root/binary_name('rvt-info'); info.write_bytes(b'fixture')
            metadata=root/'custom-phase-reader'; metadata.write_bytes(b'fixture')
            with patch.dict(os.environ,{'UVYAZKA_RVT_IFC':str(converter),'UVYAZKA_RVT_METADATA':str(metadata)},clear=True):
                status=converter_status(root)
                self.assertTrue(status['available'])
                self.assertEqual(binary_path('ifccs-rvt-metadata',root),metadata.resolve())
                self.assertIsNone(status['binaries']['rvt-ifc']['source_revision'])
                self.assertEqual(status['binaries']['rvt-ifc']['integrity'],'unverified')

    def test_planner_import_does_not_require_native_or_database_modules(self):
        code='''
import importlib.abc, sys
class BlockNative(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'numpy','ifcopenshell','PIL','mcp','sqlite3'}:
            raise ModuleNotFoundError(fullname)
sys.meta_path.insert(0,BlockNative())
from uvyazka.construction.planner import build_scenario
from uvyazka.construction.simulation import SimulationEngine
assert callable(build_scenario) and callable(SimulationEngine)
'''
        result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr)

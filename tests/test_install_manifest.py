"""Synthetic PE header/signature fixtures test staging, not signature validity."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('install_manifest', ROOT / 'tools/create_install_manifest.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallManifestTests(unittest.TestCase):
    def test_staged_bytes_version_and_machine_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); installer = root / 'Synthetic.exe'
            installer.write_bytes(b'MZ' + b'\0' * 100000)
            Path(str(installer) + '.sig').write_text(base64.b64encode(b'untrusted comment: synthetic fixture\n').decode())
            config = {'version': '1.2.3-alpha.1', 'bundle': {'windows': {'nsis': {'installMode': 'currentUser'}}}}
            result = module.stage(installer, root / 'out', config, ROOT / 'tools/install-windows.ps1')
            saved = json.loads((root / 'out/uvyazka-install.json').read_text())
            self.assertEqual(saved, result)
            name = 'uvyazka_1.2.3-alpha.1_x64-setup.exe'
            self.assertEqual((root / 'out' / name).read_bytes(), installer.read_bytes())
            self.assertEqual(result['installer']['sha256'], hashlib.sha256(installer.read_bytes()).hexdigest())
            self.assertEqual(result['bootstrap']['sha256'], hashlib.sha256((root / 'out/install-windows.ps1').read_bytes()).hexdigest())
            self.assertEqual(result['installer']['arguments'], ['/S'])
            self.assertEqual(result['installer']['scope'], 'currentUser')
            self.assertEqual(result['existing_installation'], 'use_in_app_signed_updater')
            config['bundle']['windows']['nsis']['installMode'] = 'perMachine'
            with self.assertRaises(ValueError): module.stage(installer, root / 'bad', config, ROOT / 'tools/install-windows.ps1')
            config['bundle']['windows']['nsis']['installMode'] = 'currentUser'
            for invalid in ['../other', '1.2.3/x', '1.2.3;command']:
                config['version'] = invalid
                with self.assertRaises(ValueError): module.stage(installer, root / 'bad', config, ROOT / 'tools/install-windows.ps1')
            config['version'] = '1.2.3'
            Path(str(installer) + '.sig').write_text(base64.b64encode(b'not a Tauri signature').decode())
            with self.assertRaises(ValueError): module.stage(installer, root / 'bad', config, ROOT / 'tools/install-windows.ps1')
            installer.write_bytes(b'not a PE')
            with self.assertRaises(ValueError): module.stage(installer, root / 'bad', config, ROOT / 'tools/install-windows.ps1')

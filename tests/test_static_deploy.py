"""Release integrity and rollback regressions; no network or production paths."""
import io
import hashlib
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
from tools.deploy_static_site import main


@unittest.skipIf(os.name == 'nt', 'Deployment symlinks are verified on Linux')
class StaticDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'site'
        self.previous = self.root / 'releases' / 'old'
        self.previous.mkdir(parents=True)
        (self.root / 'current').symlink_to(self.previous)
        self.files = {'index.html': b'public page', 'runtime/rvt/uvyazka_rvt_browser_bg.wasm': b'test wasm', 'runtime/nwd/uvyazka_nwd_experiment_bg.wasm': b'test nwd wasm', 'cad/index.html': b'cad'}
        self.revision = 'a' * 40
        self.manifest = {'revision': self.revision, 'version': 'test', 'mode': 'browser-compute-and-public-examples',
                         'server_file_upload': False, 'browser_file_open': True,
                         'files_sha256': {k: hashlib.sha256(v).hexdigest() for k, v in self.files.items()}}

    def deploy(self, files=None, health_failure=False, health_files=None):
        archive = Path(self.temp.name) / 'release.tar.gz'
        contents = {**(files if files is not None else self.files), 'release.json': json.dumps(self.manifest).encode()}
        with tarfile.open(archive, 'w:gz') as tar:
            for name, data in contents.items():
                member = tarfile.TarInfo(name); member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        argv = ['deploy', '--archive', str(archive), '--sha256', hashlib.sha256(archive.read_bytes()).hexdigest(),
                '--revision', self.revision, '--release', 'test-release', '--root', str(self.root), '--url', 'https://example.test/']
        served = {**self.files, **(health_files or {}), 'release.json': json.dumps(self.manifest).encode()}
        def response(url, timeout):
            if health_failure:raise OSError('offline')
            return io.BytesIO(served[urlsplit(url).path.lstrip('/')])
        with patch('sys.argv', argv), patch('tools.deploy_static_site.urlopen', side_effect=response):
            main()

    def test_verified_release_switches_and_retains_previous(self):
        self.deploy()
        self.assertEqual((self.root / 'current').resolve().name, 'test-release')
        self.assertTrue(self.previous.is_dir())

    def test_modified_payload_never_replaces_current(self):
        with self.assertRaises(AssertionError):
            self.deploy({**self.files, 'index.html': b'modified'})
        self.assertEqual((self.root / 'current').resolve(), self.previous)

    def test_failed_https_check_rolls_back_atomically(self):
        with self.assertRaises(OSError):
            self.deploy(health_failure=True)
        self.assertEqual((self.root / 'current').resolve(), self.previous)

    def test_modified_nwd_live_asset_rolls_back(self):
        with self.assertRaisesRegex(ValueError, 'Live artifact differs'):
            self.deploy(health_files={'runtime/nwd/uvyazka_nwd_experiment_bg.wasm': b'wrong nwd runtime'})
        self.assertEqual((self.root / 'current').resolve(), self.previous)
        self.assertTrue(self.previous.is_dir())

    def test_archive_traversal_does_not_write_outside_release(self):
        with self.assertRaises(AssertionError):
            self.deploy({'../escape.txt': b'private'})
        self.assertFalse((self.root / 'releases' / 'escape.txt').exists())
        self.assertEqual((self.root / 'current').resolve(), self.previous)

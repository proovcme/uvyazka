"""The Pages publisher must never discover files outside the public manifest."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from tools.publish_pages_demo import verified_files


class PagesReleaseTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.root=Path(folder.name)
        (self.root/'index.html').write_text('public')
        self.manifest={'mode':'browser-compute-and-public-examples','server_file_upload':False,'revision':'a'*40,'files_sha256':{'index.html':hashlib.sha256(b'public').hexdigest()}}
        self.save()

    def save(self):
        (self.root/'release.json').write_text(json.dumps(self.manifest))

    def test_copies_only_verified_public_files(self):
        (self.root/'private.db').write_text('never publish')
        _,files=verified_files(self.root)
        self.assertEqual([name for name,_ in files],['index.html','release.json'])

    def test_rejects_private_or_escaping_paths(self):
        for name in ['../secret','/secret','demo/../../secret','demo\\secret','private.db']:
            with self.subTest(name=name):
                self.manifest['files_sha256']={name:'0'*64};self.save()
                with self.assertRaises(ValueError):verified_files(self.root)

    def test_rejects_changed_release(self):
        (self.root/'index.html').write_text('changed')
        with self.assertRaisesRegex(ValueError,'checksum'):verified_files(self.root)

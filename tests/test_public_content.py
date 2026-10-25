import importlib.util
from pathlib import Path
import tarfile
import tempfile
import io
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('public_content', Path(__file__).resolve().parents[1] / 'tools/check_public_content.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PublicContentTests(unittest.TestCase):
    def test_forced_local_files_and_private_paths_are_rejected(self):
        for name in ('projects/model.rvt', 'docs/report.pdf', 'src/cache.sqlite3', '.env.prod', '.ssh/config', '.npmrc', 'models/weights.gguf'):
            with self.subTest(name=name):
                self.assertTrue(policy.file_issues(name, b''))
        private_path = 'C:/' + 'Users/' + 'private-owner/Documents/model.rvt'
        self.assertTrue(policy.file_issues('docs/example.md', private_path.encode()))
        self.assertEqual(policy.file_issues('docs/example.md', b'C:/Users/alice/Documents/model.rfa'), [])
        self.assertEqual(policy.file_issues('tests/fixtures/structure-synthetic.xls', b'fixture'), [])

    def test_sdist_rejects_untracked_payload_even_in_allowed_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'example.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                for name in ('README.md', 'docs/private-notes.json', 'PKG-INFO'):
                    member = tarfile.TarInfo('uvyazka-0/' + name)
                    member.size = 2
                    output.addfile(member, io.BytesIO(b'{}'))
            issues = policy.check_archive(archive, {'README.md'})
            self.assertEqual(len(issues), 1)
            self.assertIn('private-notes.json', issues[0])

    def test_wheel_maps_source_and_skill_paths_and_rejects_extra(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'example.whl'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('uvyazka/core.py', '# code')
                output.writestr('uvyazka-0.data/data/share/uvyazka/skills/reader/SKILL.md', '# skill')
                output.writestr('uvyazka-0.dist-info/METADATA', 'Name: uvyazka')
                output.writestr('uvyazka/private.json', '{}')
            issues = policy.check_archive(archive, {'src/uvyazka/core.py', 'skills/reader/SKILL.md'})
            self.assertEqual(len(issues), 1)
            self.assertIn('private.json', issues[0])

    def test_sdist_cannot_hide_traversal_by_stripping_its_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'example.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                member = tarfile.TarInfo('../README.md')
                member.size = 1
                output.addfile(member, io.BytesIO(b'x'))
            self.assertTrue(policy.check_archive(archive, {'README.md'}))

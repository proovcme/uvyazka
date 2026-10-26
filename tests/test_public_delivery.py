"""An origin health check must not silently verify another deployment."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import io
import json
import hashlib
import unittest
from unittest.mock import patch

from tools import check_public_delivery, deploy_static_site


class PublicDeliveryTests(unittest.TestCase):
    def test_all_files_includes_archives_and_checks_their_hashes(self):
        files = {'index.html': b'<html></html>', 'downloads/source.tar.gz': b'archive'}
        manifest = {'mode': 'browser-compute-and-public-examples', 'revision': 'a' * 40,
                    'files_sha256': {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}}
        requested = []

        def fetch(base, name, timeout):
            requested.append(name)
            return (json.dumps(manifest).encode() if name == 'release.json' else files[name], {'path': name})

        with patch.object(check_public_delivery, 'fetch', side_effect=fetch):
            result = check_public_delivery.check('https://example.test/', all_files=True)
            self.assertEqual({item['path'] for item in result['downloads']}, set(files))
            self.assertEqual(requested.count('index.html'), 1)
            files['downloads/source.tar.gz'] = b'incomplete'
            with self.assertRaisesRegex(ValueError, 'Incomplete or modified'):
                check_public_delivery.check('https://example.test/', all_files=True)

    def test_same_revision_with_different_downloads_is_rejected(self):
        manifest = {'revision': 'a' * 40, 'files_sha256': {'index.html': 'old'}}
        live = {**manifest, 'files_sha256': {'index.html': 'new'}}
        with patch.object(deploy_static_site, 'urlopen', return_value=io.BytesIO(json.dumps(live).encode())) as opened:
            with self.assertRaisesRegex(ValueError, 'manifest differs'):
                deploy_static_site.verify_live_release('https://example.test/', manifest)
            opened.assert_called_once()

    def test_redirects_are_rejected_before_fetching_destination(self):
        for module in [check_public_delivery, deploy_static_site]:
            with self.subTest(module=module.__name__):
                visited = []

                class Handler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        visited.append(self.path)
                        self.send_response(302)
                        self.send_header('Location', '/mirror/release.json')
                        self.end_headers()

                    def log_message(self, *args):
                        pass

                server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
                worker = Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    url = f'http://127.0.0.1:{server.server_port}/release.json'
                    with self.assertRaisesRegex(ValueError, 'redirected'):
                        module.urlopen(url, timeout=2)
                    self.assertEqual(visited, ['/release.json'])
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join()

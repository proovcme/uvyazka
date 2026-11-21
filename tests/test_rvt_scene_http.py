import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import struct
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from uvyazka.construction import rvt_scene_http
from uvyazka.construction.rvt_runtime import OLE_SIGNATURE
from uvyazka.core import Workspace
from uvyazka.dashboard import make_handler


def test_direct_rvt_route_requires_token_and_returns_exact_source_frame(tmp_path, monkeypatch):
    workspace = Workspace(tmp_path / 'state')
    binary = tmp_path / 'reader'
    binary.write_bytes(b'fixture')
    source = OLE_SIGNATURE + b'synthetic RVT input'
    fingerprint = hashlib.sha256(source).hexdigest()
    def read(executable, copied, manifest, geometry, connection):
        assert executable == binary
        assert copied.read_bytes() == source
        manifest.write_bytes(b'{"contract":"RvtDirectScene"}')
        geometry.write_bytes(bytes(range(12)))
        return True
    monkeypatch.setattr(rvt_scene_http, 'direct_binary', lambda workspace: binary)
    monkeypatch.setattr(rvt_scene_http, 'run_reader', read)
    server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(workspace))
    server.daemon_threads = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}' + rvt_scene_http.PATH
    try:
        with urlopen(url) as response:
            config = json.load(response)
        assert config['available']
        headers = {'Content-Type': 'application/octet-stream', 'X-Uvyazka-Source-Sha256': fingerprint}
        with pytest.raises(HTTPError) as denied:
            urlopen(Request(url, source, headers))
        assert denied.value.code == 403
        headers['X-Uvyazka-Token'] = config['token']
        with pytest.raises(HTTPError) as denied:
            urlopen(Request(url, source, {**headers, 'Origin':'https://example.invalid'}))
        assert denied.value.code == 403
        with pytest.raises(HTTPError) as invalid:
            urlopen(Request(url, source, {**headers, 'X-Uvyazka-Source-Sha256':'0'*64}))
        assert invalid.value.code == 400
        with urlopen(Request(url, source, headers)) as response:
            packet = response.read()
            assert response.headers['X-Uvyazka-Source-Sha256'] == fingerprint
            assert response.headers['X-Uvyazka-Reader-Sha256'] == hashlib.sha256(binary.read_bytes()).hexdigest()
        end = 4 + struct.unpack_from('<I', packet)[0]
        assert json.loads(packet[4:end]) == {'contract':'RvtDirectScene'}
        assert packet[end:] == bytes(range(12))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert list(Path(workspace.home).glob('rvt-scene-*')) == []

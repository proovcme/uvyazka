"""Native RVT graphics for the local viewer, independent of IFC conversion."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import select
import socket
import struct
import subprocess
import tempfile
import threading
import time

from .rvt_runtime import OLE_SIGNATURE, RVT_MAX_BYTES, SCENE_NAME, binary_name, binary_path, sha256


PATH = '/api/models/rvt-scene'
MAX_MANIFEST = 128 * 1024**2
MAX_GEOMETRY = 512 * 1024**2
CHUNK = 1024**2


def direct_binary(workspace):
    try:
        return binary_path(SCENE_NAME, workspace.home)
    except ValueError:
        # Older managed manifests lack this optional binary. A checkout may
        # supply its locally compiled reader while the MCP runtime stays active.
        root = Path(__file__).resolve().parents[3]
        return root / 'integrations/rvt-browser-bridge/target/release' / binary_name(SCENE_NAME)


def connection_closed(connection):
    try:
        readable, _, _ = select.select([connection], [], [], 0)
        return bool(readable) and not connection.recv(1, socket.MSG_PEEK)
    except (ConnectionAbortedError, ConnectionResetError):
        return True


def run_reader(executable, source, manifest, geometry, connection):
    log = manifest.with_suffix('.log')
    deadline = time.monotonic() + 900
    with log.open('wb') as stream, subprocess.Popen(
        [executable, source, manifest, geometry],
        stdout=subprocess.DEVNULL, stderr=stream,
    ) as process:
        try:
            while process.poll() is None:
                if connection_closed(connection):
                    return False
                if time.monotonic() >= deadline:
                    raise ValueError('Истекло время чтения сохранённой графики RVT.')
                time.sleep(0.2)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    if process.returncode or not manifest.is_file() or not geometry.is_file():
        with log.open('rb') as stream:
            stream.seek(max(0, log.stat().st_size - 2000))
            raise ValueError('Native RVT scene failed: ' + stream.read().decode('utf-8', errors='replace'))
    return True


def chunks(path):
    with path.open('rb') as stream:
        yield from iter(lambda: stream.read(CHUNK), b'')


class RvtSceneUploads:
    def __init__(self, workspace):
        self.workspace = workspace
        self.slot = threading.BoundedSemaphore(1)

    def config(self, token):
        return {
            'available': direct_binary(self.workspace).is_file(),
            'max_bytes': RVT_MAX_BYTES, 'token': token,
        }

    def serve(self, handler):
        if handler.headers.get('Content-Type') != 'application/octet-stream' or handler.headers.get('Transfer-Encoding'):
            raise ValueError('Raw RVT with Content-Length required')
        length = int(handler.headers.get('Content-Length', 0))
        supplied_sha = handler.headers.get('X-Uvyazka-Source-Sha256', '')
        if not 8 <= length <= RVT_MAX_BYTES or not re.fullmatch('[0-9a-f]{64}', supplied_sha):
            raise ValueError('Expected RVT within size budget and source SHA-256')
        executable = direct_binary(self.workspace)
        if not executable.is_file():
            raise ValueError('Native RVT scene runtime unavailable')
        if not self.slot.acquire(blocking=False):
            handler.send({'error': 'Дождитесь завершения текущего чтения RVT.'}, status=409)
            return
        try:
            handler.connection.settimeout(60)
            with tempfile.TemporaryDirectory(prefix='rvt-scene-', dir=self.workspace.home) as directory:
                folder = Path(directory)
                source, manifest, geometry = (folder / name for name in ('source.rvt', 'scene.json', 'geometry.bin'))
                source_hash = hashlib.sha256()
                remaining = length
                with source.open('xb') as output:
                    while remaining:
                        block = handler.rfile.read(min(CHUNK, remaining))
                        if not block:
                            raise ValueError('RVT upload ended early')
                        if remaining == length and not block.startswith(OLE_SIGNATURE):
                            raise ValueError('RVT container signature missing')
                        output.write(block)
                        source_hash.update(block)
                        remaining -= len(block)
                if source_hash.hexdigest() != supplied_sha:
                    raise ValueError('RVT differs from the selected file')
                decoder = sha256(executable)
                if not run_reader(executable, source, manifest, geometry, handler.connection):
                    return
                if sha256(executable) != decoder:
                    raise ValueError('Native RVT scene reader changed during extraction')
                manifest_size, geometry_size = manifest.stat().st_size, geometry.stat().st_size
                if not 0 < manifest_size <= MAX_MANIFEST or not 0 < geometry_size <= MAX_GEOMETRY:
                    raise ValueError('Native RVT scene exceeds its output budget or is empty')
                header = {
                    'X-Uvyazka-Source-Sha256': supplied_sha,
                    'X-Uvyazka-Reader-Sha256': decoder,
                }
                def response_parts():
                    yield struct.pack('<I', manifest_size)
                    yield from chunks(manifest)
                    yield from chunks(geometry)
                handler.send(response_parts(), 'application/octet-stream',
                             content_length=4 + manifest_size + geometry_size, extra_headers=header)
        finally:
            self.slot.release()

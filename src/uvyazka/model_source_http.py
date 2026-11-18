"""A bounded, hash-verified CAD original for the existing browser reader.

No path input, parsing, source mutation or permanent copy. Bytes are verified
before headers are sent; large files stay on a temporary spool, not in RAM.
"""
import hashlib
import shutil
import tempfile
from .model_data import ModelData

MAX_CAD_SOURCE = 64 * 1024 * 1024


def serve_original(handler, workspace, query):
    project, dataset, object_id, sha = (query.get(k, '') for k in ('project_id', 'dataset_id', 'object_id', 'sha256'))
    if len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
        raise ValueError('Pinned SHA-256 required')
    service = ModelData(workspace)
    # Object lookup prevents accepting a locator from a different saved dataset.
    part = service.object(project, dataset, object_id, max_chars=100, verify_source=True)
    source = part['source']
    if source.get('format') not in {'dwg', 'dxf'}:
        return handler.send({'error': 'Only registered CAD originals are served here'}, status=400)
    if source.get('sha256') != sha or part['freshness']['status'] != 'content_hash_matches':
        return handler.send({'error': 'Source revision changed'}, status=409)
    record, path = workspace.source_record(project, source['doc_id'])
    if path.stat().st_size > MAX_CAD_SOURCE:
        return handler.send({'error': 'CAD original exceeds the 64 MiB viewer budget; saved properties remain available'}, status=413)
    with tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024) as copy:
        checksum = hashlib.sha256()
        size = 0
        with path.open('rb') as original:
            while block := original.read(64 * 1024):
                size += len(block)
                if size > MAX_CAD_SOURCE:
                    return handler.send({'error': 'CAD original exceeds viewer budget'}, status=413)
                checksum.update(block)
                copy.write(block)
        # This checks the exact delivered copy, including changes after preflight.
        if checksum.hexdigest() != sha:
            return handler.send({'error': 'Source changed while reading'}, status=409)
        copy.seek(0)
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/octet-stream')
        handler.send_header('Content-Length', str(size))
        handler.send_header('X-Uvyazka-Source-SHA256', sha)
        handler.send_header('Cache-Control', 'no-store')
        handler.end_headers()
        shutil.copyfileobj(copy, handler.wfile, 64 * 1024)

"""Bounded local PDF OCR. Cached evidence is versioned; originals stay read-only."""
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from .core import connection, digest, encode, now


def engine_info(language):
    if not isinstance(language, str) or not re.fullmatch(r'[a-z]{3}(?:\+[a-z]{3}){0,3}', language):
        raise ValueError('Use explicit Tesseract languages, e.g. rus+eng')
    binary = os.environ.get('UVYAZKA_TESSERACT') or shutil.which('tesseract')
    standard = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Tesseract-OCR/tesseract.exe'
    if not binary and standard.is_file(): binary = str(standard)
    if not binary or not Path(binary).is_file():
        raise ValueError('Local Tesseract is unavailable. Install Tesseract with rus/eng data or set UVYAZKA_TESSERACT.')
    options = {'capture_output': True, 'text': True, 'encoding': 'utf-8', 'errors': 'replace', 'timeout': 15, 'check': True,
               'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
    version = subprocess.run([binary, '--version'], **options).stdout.splitlines()[0]
    available = subprocess.run([binary, '--list-langs'], **options).stdout.splitlines()
    missing = set(language.split('+')) - set(available)
    if missing: raise ValueError('Missing local Tesseract languages: ' + ', '.join(sorted(missing)))
    return {'binary': binary, 'version': version, 'language': language, 'engine': 'Tesseract', 'method_revision': 'pdf-ocr-v1'}


def recognize(page, engine, dpi):
    # Large drawings use a bounded raster; actual DPI is always reported.
    area = page.rect.width * page.rect.height
    if area <= 0: raise ValueError('Invalid PDF page bounds')
    scale = min(dpi / 72, math.sqrt(20_000_000 / area))
    import pymupdf
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
    with tempfile.TemporaryDirectory(prefix='uvyazka-ocr-') as folder:
        image = Path(folder) / 'page.png'; image.write_bytes(pixmap.tobytes('png'))
        response = subprocess.run([engine['binary'], str(image), 'stdout', '-l', engine['language'], '--dpi', str(max(1, round(72 * scale))), 'tsv'],
                                  capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if response.returncode: raise ValueError('Tesseract failed: ' + response.stderr[-1500:])
    words, lines = [], {}
    for row in csv.DictReader(io.StringIO(response.stdout), delimiter='\t'):
        if row.get('level') != '5' or not row.get('text', '').strip(): continue
        if len(words) >= 30000: raise ValueError('OCR page exceeds 30000 words; choose a bounded page copy')
        x, y, w, h = (int(row[k]) for k in ('left', 'top', 'width', 'height'))
        confidence = float(row['conf'])
        if not math.isfinite(confidence): raise ValueError('Invalid OCR confidence')
        word = {'text': row['text'], 'bbox_pt': [x/scale, y/scale, (x+w)/scale, (y+h)/scale],
                'confidence': confidence, 'line': [int(row[k]) for k in ('block_num', 'par_num', 'line_num')]}
        words.append(word); lines.setdefault(tuple(word['line']), []).append(word['text'])
    return {'text': '\n'.join(' '.join(line) for line in lines.values()), 'words': words, 'actual_dpi': 72*scale,
            'page_rect_pt': list(page.rect), 'rotation': page.rotation, 'coordinate_space': 'rendered_page_points_top_left'}


class PdfOCR:
    def __init__(self, workspace): self.workspace = workspace

    def extract(self, project_id, doc_id, pages, request_id, language='rus+eng', dpi=300, force=False, word_offset=0, word_limit=0):
        if not isinstance(pages, list) or not 1 <= len(pages) <= 5 or any(type(p) is not int or p < 1 for p in pages) or len(set(pages)) != len(pages):
            raise ValueError('Select 1–5 distinct physical PDF pages (1-based)')
        if type(dpi) is not int or not 150 <= dpi <= 400 or type(force) is not bool:
            raise ValueError('dpi must be 150–400 and force must be boolean')
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError('request_id must have 1–128 characters')
        if type(word_offset) is not int or word_offset < 0 or type(word_limit) is not int or not 0 <= word_limit <= 40:
            raise ValueError('word_offset >= 0; word_limit 0–40 per page')
        record, source = self.workspace.source_record(project_id, doc_id)
        if record['extension'] != '.pdf' or source.stat().st_size > 64*1024**2:
            raise ValueError('A registered PDF up to 64 MiB is required')
        if self.workspace.source_state(project_id, doc_id, full_hash=True)['status'] != 'content_hash_matches':
            raise ValueError('Source changed; scan and reread before OCR')
        fingerprint = hashlib.sha256(encode([doc_id, record['sha256'], sorted(pages), language, dpi, force]).encode()).hexdigest()
        database = self.workspace.db_path(project_id)
        with connection(database) as db:
            db.execute('create table if not exists pdf_ocr_requests(request_id text primary key,fingerprint text not null,payload text not null)')
            retry = db.execute('select * from pdf_ocr_requests where request_id=?', (request_id,)).fetchone()
        if retry:
            if retry['fingerprint'] != fingerprint: raise ValueError('request_id was used for another OCR request')
            return self.result(project_id, json.loads(retry['payload']), word_offset, word_limit, True)
        engine = engine_info(language)
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != record['sha256']: raise ValueError('Source changed before OCR')
        import pymupdf
        from .readers import revision_for
        with connection(database, readonly=True) as db:
            previous = [dict(r) for r in db.execute('select * from pages where doc_id=? and sha256=? and parser_revision=? order by page_number', (doc_id, record['sha256'], record['parser_revision']))]
        # Existing literal pages are copied into a new immutable extraction, not overwritten.
        blocks = [{'text': p['text'], 'locator': json.loads(p['locator'])} for p in previous] if previous else []
        results = []
        with pymupdf.open(stream=data, filetype='pdf') as document:
            if document.needs_pass or max(pages) > len(document): raise ValueError('PDF encrypted or page outside document')
            if len(document) > 10000: raise ValueError('PDF exceeds 10000 pages; use a bounded copy')
            if not previous: blocks = [{'text': page.get_text(), 'locator': {'kind': 'pdf_page', 'pdf_page': n}} for n, page in enumerate(document, 1)]
            if len(blocks) != len(document): raise ValueError('Incomplete baseline; scan the PDF before OCR')
            for number in sorted(pages):
                page = document[number-1]
                if page.get_text().strip() and not force:
                    results.append({'page_number': number, 'status': 'native_text_available', 'words': [], 'text': blocks[number-1]['text']}); continue
                output = recognize(page, engine, dpi)
                status = 'ocr_requires_review' if output['text'].strip() else 'no_text_recognized'
                locator = {'kind': 'pdf_page', 'pdf_page': number, 'extraction_method': 'ocr', 'engine': engine['engine'],
                           'engine_version': engine['version'], 'language': language, 'requested_dpi': dpi,
                           **{k: v for k, v in output.items() if k not in ('text', 'words')},
                           'word_count': len(output['words']), 'ocr_request_id': request_id, 'requires_visual_review': True,
                           'table_structure_verified': False}
                blocks[number-1] = {'text': output['text'], 'locator': locator}
                results.append({'page_number': number, 'status': status, **output})
        if digest(source) != record['sha256']: raise ValueError('Source changed during OCR; previous extraction retained')
        base = revision_for('.pdf')
        revision = base + '.ocr.' + hashlib.sha256(encode([blocks, engine['version'], language, dpi]).encode()).hexdigest()[:24]
        if all(p['status'] == 'native_text_available' for p in results): revision = record['parser_revision']
        payload = {'doc_id': doc_id, 'sha256': record['sha256'], 'parser_revision': revision, 'request_id': request_id,
                   'created_at': now(),
                   'engine': {k: v for k, v in engine.items() if k != 'binary'}, 'pages': results,
                   'note': 'OCR is unconfirmed source evidence. Check numbers, signs, units, headers and merged cells against the original page.'}
        with connection(database) as db:
            db.execute('begin immediate')
            current = db.execute('select sha256,parser_revision from documents where doc_id=?', (doc_id,)).fetchone()
            if (current['sha256'], current['parser_revision']) != (record['sha256'], record['parser_revision']):
                raise ValueError('Extraction changed concurrently; retry with a new request_id')
            for row in db.execute('select chunk_id from chunks where doc_id=?', (doc_id,)).fetchall():
                db.execute('delete from chunk_fts where rowid=?', (row[0],))
            db.execute('delete from chunks where doc_id=?', (doc_id,))
            db.execute('insert or ignore into document_versions values (?,?,?,?)', (doc_id, record['sha256'], revision, now()))
            for number, block in enumerate(blocks, 1):
                text = block['text']
                db.execute('insert or ignore into pages values (?,?,?,?,?,?,?)', (doc_id, record['sha256'], revision, number, text, encode(block['locator']), int(len(text.strip()) < 80)))
                for part, start in enumerate(range(0, len(text), 1600)):
                    chunk = text[start:start+1800]
                    cursor = db.execute('insert into chunks(doc_id,sha256,page_number,part,text) values (?,?,?,?,?)', (doc_id, record['sha256'], number, part, chunk))
                    db.execute('insert into chunk_fts(rowid,text) values (?,?)', (cursor.lastrowid, chunk))
            db.execute('update documents set parser_revision=?,index_status=?,page_count=?,error=null where doc_id=?', (revision, 'text_indexed', len(blocks), doc_id))
            db.execute('insert into pdf_ocr_requests values (?,?,?)', (request_id, fingerprint, encode(payload)))
            db.execute('insert into events(created_at,kind,payload) values (?,?,?)', (now(), 'pdf_ocr_saved', encode({k: v for k, v in payload.items() if k != 'pages'})))
        return self.result(project_id, payload, word_offset, word_limit, False)

    def result(self, project_id, payload, offset, limit, cached):
        current, _ = self.workspace.source_record(project_id, payload['doc_id'])
        summaries = []
        for page in payload['pages']:
            words = page['words']; end = min(len(words), offset+limit)
            summaries.append({k: v for k, v in page.items() if k not in ('text', 'words')} | {
                'text_preview': page['text'][:200], 'word_count': len(words), 'words': words[offset:end],
                'word_offset': offset, 'next_word_offset': end if limit and end < len(words) else None})
        return {k: v for k, v in payload.items() if k != 'pages'} | {'project_id': project_id, 'pages': summaries, 'cache_reused': cached,
                'source_freshness': self.workspace.source_state(project_id, payload['doc_id']),
                'freshness': 'current_extraction' if current['parser_revision'] == payload['parser_revision'] else 'historical_snapshot', 'resume_tool': 'read_evidence'}


def register_tools(mcp, workspace):
    @mcp.tool(annotations={'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True})
    def ocr_pdf_pages(project_id: str, doc_id: str, pages: list[int], request_id: str, language: str = 'rus+eng', dpi: int = 300,
                      force: bool = False, word_offset: int = 0, word_limit: int = 0) -> dict:
        """Locally OCR 1–5 registered PDF pages using Tesseract, cache a versioned extraction and index it.
        No cloud/model API or source writes. Native-text pages are skipped unless force=true.
        Repeat an identical request_id to reuse cached results; word_limit 0–40 pages through word boxes/confidence.
        Read full text via read_evidence with returned parser_revision, then visually verify OCR numbers/tables.
        OCR never confirms merged cells, table semantics or an engineering value."""
        return PdfOCR(workspace).extract(project_id, doc_id, pages, request_id, language, dpi, force, word_offset, word_limit)

"""A registered, hash-verified byte snapshot shared by PDF tools."""
import hashlib
from contextlib import contextmanager
from threading import RLock

# PyMuPDF table detection uses module-level state. Serialize our PDF sessions.
PDF_LOCK = RLock()


@contextmanager
def open_pdf(workspace, project_id, doc_id, sha256):
    record, path = workspace.source_record(project_id, doc_id)
    if record["sha256"] != sha256 or path.suffix.lower() != ".pdf":
        raise ValueError("Choose the registered current PDF hash")
    if not path.is_file() or not 0 < path.stat().st_size <= 64*1024*1024:
        raise ValueError("PDF unavailable or exceeds 64 MiB")
    # Bound the read as well as the stat: a file can grow between these operations.
    with path.open('rb') as stream:
        data = stream.read(64*1024*1024+1)
    if len(data) > 64*1024*1024 or hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError("Source changed; scan and review the new revision")
    try:
        import pymupdf
    except ImportError as exc:
        raise ValueError("Install uvyazka[readers] for PDF tools") from exc
    with PDF_LOCK, pymupdf.open(stream=data, filetype="pdf") as pdf:
        if pdf.needs_pass:
            raise ValueError("Encrypted PDF requires a readable source")
        yield pdf

"""Compress old JSON rows and return unused SQLite pages to the disk.

Run with the project closed after updating its readers. Each batch is a
lossless transaction, so an interrupted run can resume against mixed rows.
"""

import argparse
from pathlib import Path
import sys
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from uvyazka.construction.rvt_data import MAX_NATIVE_RECORD_BYTES
from uvyazka.core import Workspace, connection


def compact(workspace, project):
    path = workspace.db_path(project)
    start = path.stat().st_size
    converted = 0
    with connection(path) as db:
        if not db.execute("select 1 from sqlite_master where name='rvt_native_records'").fetchone():
            return {'project_id': project, 'records': 0, 'before_bytes': start, 'after_bytes': start}
        count = db.execute('select count(*) from rvt_native_records').fetchone()[0]
        cursor = 0
        while True:
            db.execute('begin immediate')
            batch = []
            raw_bytes = 0
            with_rows = db.execute("select rowid,payload from rvt_native_records where rowid>? and typeof(payload)='text' order by rowid limit 512", (cursor,))
            try:
                for rowid, payload in with_rows:
                    cursor = rowid
                    raw = payload.encode('utf-8')
                    if len(raw) > MAX_NATIVE_RECORD_BYTES:
                        raise ValueError('Legacy RVT row exceeds the lossless compression limit')
                    packed = zlib.compress(raw, level=3)
                    if zlib.decompress(packed) != raw:
                        raise ValueError('Compression round trip failed')
                    batch.append((packed, rowid))
                    raw_bytes += len(raw)
                    if raw_bytes >= 16 * 1024**2:
                        break
            finally:
                with_rows.close()
            if not batch:
                db.commit()
                break
            db.executemany('update rvt_native_records set payload=? where rowid=?', batch)
            db.commit()
            converted += len(batch)
        if db.execute('pragma freelist_count').fetchone()[0]:
            db.execute('vacuum')
        if db.execute('select count(*) from rvt_native_records').fetchone()[0] != count or db.execute('pragma quick_check').fetchone()[0] != 'ok':
            raise ValueError('Compacted database failed verification')
        db.execute('pragma wal_checkpoint(truncate)')
    return {'project_id': project, 'records': converted, 'before_bytes': start, 'after_bytes': path.stat().st_size}


if __name__ == '__main__':
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project_id')
    parser.add_argument('--home', type=Path)
    arguments = parser.parse_args()
    print(json.dumps(compact(Workspace(arguments.home), arguments.project_id), ensure_ascii=False))

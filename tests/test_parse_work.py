import asyncio
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import pytest

from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.parse_work import ParseWork


@pytest.fixture
def project():
    with TemporaryDirectory() as folder:
        root = Path(folder)
        sources = root / "sources"
        sources.mkdir()
        table = sources / "Q-01-ГП.ВОР.csv"
        table.write_text("Работа;Ед.;Количество\nПокрытие;м2;1,84\n", encoding="utf-8")
        (sources / "legacy.doc").write_bytes(b"unsupported synthetic source")
        workspace = Workspace(root / "state")
        workspace.create_project("p", "Synthetic", sources)
        scan(workspace, "p")
        docs = {row["extension"]: row["doc_id"] for row in workspace.find_documents("p")["documents"]}
        yield workspace, table, docs


def observation(raw="1,84"):
    return {"name": "Площадь покрытия", "group": "quantities", "value": "1.84", "raw_value": raw,
            "unit": "м2", "basis": "По строке ведомости"}


def test_scope_progress_atomic_failure_and_source_refresh(project):
    workspace, table, docs = project
    work = ParseWork(workspace, "p")
    assert work.get()["jobs"] == []
    start = work.start("quantities", [docs[".csv"], docs[".doc"]], "Площадь работ")
    assert start["counts"] == {"pending": 2, "observed": 0, "no_data": 0, "blocked": 1, "stale": 0}
    assert start["units"][1]["locator"]["row"] == 2
    assert any(hint["value"] == "quantity_schedule" for hint in start["documents"][0]["navigation_hints"])
    blocked = work.get("quantities", state="blocked")
    assert blocked["units"][0]["source"]["page_number"] is None
    assert blocked["documents"][1]["index_status"] == "unsupported"

    header = {"unit_number": 1, "state": "no_data", "note": "Строка заголовков"}
    reading = {"unit_number": 2, "state": "observed", "observations": [observation(), observation("184")]}
    with pytest.raises(ValueError, match="raw_value"):
        work.submit("quantities", "batch-1", [header, reading])
    assert work.get("quantities")["counts"] == start["counts"]
    assert workspace.get_project_facts("p")["facts"] == []

    reading["observations"].pop()
    receipt = work.submit("quantities", "batch-1", [header, reading])
    assert work.submit("quantities", "batch-1", [header, reading]) == receipt
    with pytest.raises(ValueError, match="different"):
        work.submit("quantities", "batch-1", [header])
    facts = workspace.get_project_facts("p")["facts"]
    assert len(facts) == 1
    fact = facts[0]
    assert fact["reader"] == "model"
    assert fact["status"] == "source_observation"
    assert fact["revision_approved"] is False
    assert fact["sources"] == [start["units"][1]["source"]]
    assert not work.start("quantities", [docs[".csv"], docs[".doc"]], "Площадь работ")["complete"]
    with pytest.raises(ValueError, match="different"):
        work.start("quantities", [docs[".csv"]], "Площадь работ")
    work.start("freshness", [docs[".csv"]], "Площадь работ")

    # Preserve size and mtime to verify actual bytes when requested.
    stat = table.stat()
    table.write_text(table.read_text(encoding="utf-8").replace("1,84", "1,85"), encoding="utf-8")
    os.utime(table, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert work.get("quantities")["counts"]["observed"] == 1
    stale = work.get("quantities", state="stale", verify_sources=True)
    assert stale["counts"]["stale"] == len(stale["units"]) == 2
    assert stale["units"][1]["observations"] == receipt["results"][1]["observations"]
    with pytest.raises(ValueError, match="Source changed"):
        work.submit("freshness", "outdated", [reading])
    scan(workspace, "p")
    assert work.get("quantities", state="stale")["counts"]["stale"] == 2
    assert work.start("quantities-v2", [docs[".csv"]], "Площадь работ")["counts"]["pending"] == 2


def test_sparse_pdf_requires_visual_inspection_for_no_data(project):
    fitz = pytest.importorskip("pymupdf")
    workspace, table, _ = project
    with fitz.open() as document:
        document.new_page()
        document.save(table.parent / "scan.pdf")
    scan(workspace, "p")
    doc = workspace.find_documents("p", query="scan.pdf")["documents"][0]
    work = ParseWork(workspace, "p")
    job = work.start("sparse", [doc["doc_id"]], "Показатели")
    assert job["units"][0]["low_text"]
    result = {"unit_number": 1, "state": "no_data", "note": "Проверен пустой лист"}
    with pytest.raises(ValueError, match="visual_original"):
        work.submit("sparse", "empty", [result])
    work.submit("sparse", "empty", [{**result, "method": "visual_original"}])
    assert work.get("sparse")["complete"]


def test_protocol_restart_keeps_progress(project):
    mcp = pytest.importorskip("mcp")
    from mcp.client.stdio import stdio_client

    workspace, _, docs = project

    async def check():
        params = mcp.StdioServerParameters(command=sys.executable, args=["-m", "uvyazka.server"],
                                          env={**os.environ, "UVYAZKA_HOME": str(workspace.home)})
        for first in (True, False):
            async with stdio_client(params) as (read, write):
                async with mcp.ClientSession(read, write) as session:
                    await session.initialize()

                    async def call(tool, **args):
                        reply = await session.call_tool(tool, {"project_id": "p", **args})
                        assert not reply.isError, reply
                        return json.loads(reply.content[0].text)

                    if first:
                        await call("start_project_parse", job_id="restart", doc_ids=[docs[".csv"]], purpose="Площадь")
                        await call("submit_project_parse", job_id="restart", request_id="first", results=[
                            {"unit_number": 1, "state": "no_data", "note": "Заголовок"},
                        ])
                    else:
                        saved = await call("get_project_parse", job_id="restart")
                        assert saved["counts"]["no_data"] == 1
                        unit, = saved["units"]
                        evidence = await call("read_evidence", **unit["source"])
                        assert "1,84" in evidence["text"]
                        await call("submit_project_parse", job_id="restart", request_id="second", results=[
                            {"unit_number": unit["unit_number"], "state": "observed", "observations": [observation()]},
                        ])
                        assert (await call("get_project_parse", job_id="restart", verify_sources=True))["complete"]

    asyncio.run(asyncio.wait_for(check(), timeout=45))

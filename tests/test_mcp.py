import asyncio
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

from uvyazka.core import Workspace
from uvyazka.demo import create_demo

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except ImportError:
    ClientSession = None


@unittest.skipIf(ClientSession is None, "MCP extra not installed")
class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_server_without_optional_bim_libraries(self):
        code = '''
import asyncio, importlib.abc, sys, tempfile
from pathlib import Path
class BlockBIM(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'numpy','ifcopenshell','ezdxf','PIL','pymupdf','fitz'}:
            raise ModuleNotFoundError(fullname)
sys.meta_path.insert(0, BlockBIM())
from uvyazka.core import Workspace
from uvyazka.server import build_server
with tempfile.TemporaryDirectory() as directory:
    server = build_server(Workspace(Path(directory)/'state'))
    assert len(asyncio.run(server.list_tools())) == 79
    asyncio.run(server.call_tool('construction_schema', {}))
    asyncio.run(server.call_tool('get_unit_catalog', {'dimension': 'flow'}))
    asyncio.run(server.call_tool('rvt_converter_status', {}))
'''
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    async def test_official_stdio_client_and_observation(self):
        await asyncio.wait_for(self.check_protocol(), timeout=60)

    async def test_viewer_catalogue_import_survives_mcp_restart(self):
        from test_rvt_catalog import catalogue
        from uvyazka.ingest import scan
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'input';source.mkdir()
            (source/'catalogue.json').write_text(json.dumps(catalogue()),encoding='utf-8')
            workspace=Workspace(root/'state');workspace.create_project('shared','Shared',source);scan(workspace,'shared')
            doc_id=workspace.find_documents('shared')['documents'][0]['doc_id']
            params=StdioServerParameters(command=sys.executable,args=['-m','uvyazka.server'],env={**os.environ,'UVYAZKA_HOME':str(workspace.home),'PYTHONUTF8':'1'})
            async def call(session,name,args):
                result=await session.call_tool(name,args);self.assertFalse(result.isError,result)
                return json.loads(next(c.text for c in result.content if c.type=='text'))
            key=None
            for iteration in range(2):
                async with stdio_client(params) as (read,write):
                    async with ClientSession(read,write) as session:
                        await session.initialize()
                        saved=await call(session,'import_rvt_catalog',{'project_id':'shared','doc_id':doc_id,'request_id':'viewer-import'})
                        if key:self.assertEqual(saved['extraction_id'],key)
                        key=saved['extraction_id']
                        listed=await call(session,'list_rvt_catalogs',{'project_id':'shared','source_sha256':'a'*64})
                        self.assertEqual(listed['items'][0]['extraction_id'],key)
                        page=await call(session,'get_rvt_data',{'project_id':'shared','extraction_id':key,'section':'schedules'})
                        self.assertEqual(page['items'][0]['element_id'],'42')
                        values=await call(session,'get_rvt_record',{'project_id':'shared','extraction_id':key,'record_id':0,'section':'schedule_cells'})
                        self.assertEqual(values['items'][0]['properties']['m_text'],'')

    async def test_structure_readings_survive_stdio_restart(self):
        from uvyazka.intake import ProjectIntake
        from uvyazka.project_structure import ProjectStructure
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'sources';source.mkdir()
            (source/'table.csv').write_text('Pump,10\n',encoding='utf-8')
            workspace=Workspace(root/'state');intake=ProjectIntake(workspace)
            job=intake.import_folder(source,background=False);result=intake.run(job['intake_id']);project=result['project_id']
            params=StdioServerParameters(command=sys.executable,args=['-m','uvyazka.server'],env={**os.environ,'UVYAZKA_HOME':str(workspace.home),'PYTHONUTF8':'1'})
            async def call(session,name,args):
                result=await session.call_tool(name,args);self.assertFalse(result.isError,result)
                return json.loads(next(c.text for c in result.content if c.type=='text'))
            tid=None
            for iteration in range(2):
                async with stdio_client(params) as (read,write):
                    async with ClientSession(read,write) as session:
                        await session.initialize()
                        tables=await call(session,'get_project_structure',dict(project_id=project,kind='tables'))
                        if tid:self.assertEqual(tid,tables['items'][0]['table_id'])
                        tid=tables['items'][0]['table_id']
                        table=await call(session,'read_structure_table',dict(project_id=project,table_id=tid))
                        if not iteration:
                            await call(session,'record_structure_review',dict(project_id=project,cell_id=table['rows'][0][1]['cell_id'],reader='model',observed_text='10',state='value',method='native_source',request_id='model-read'))
                            await call(session,'save_structure_analysis',dict(project_id=project,analysis_id='pump',table_id=tid,title='Pump quantity',summary='Second column is a count.',data={'columns':{'2':'quantity'},'checks':[{'id':'count','status':'question','title':'Confirm quantity basis'}]},reader='model',request_id='model-analysis',evidence_cells=[table['rows'][0][1]['cell_id']]))
                            original=table['table']['source']
                            anchor={k:original[k] for k in ('doc_id','sha256')}
                            await call(session,'create_review_task',dict(project_id=project,task_id='resume',title='Pump review',scope='One selected row; remaining project unreviewed.',units=[dict(id='pump',title='Pump',sources=[anchor])],request_id='task-create'))
                            await call(session,'update_review_task',dict(project_id=project,task_id='resume',updates=[dict(unit_id='pump',state='reviewed',result=dict(analysis_id='pump',reader='model',revision=1,check_id='count'))],expected_revision=1,request_id='task-progress',reason='Read selected source'))
                            await call(session,'save_structure_analysis',dict(project_id=project,analysis_id='source-only',table_id=None,title='Original source',summary='No table anchor required.',data={'checks':[{'status':'unchecked','title':'Connection path'}]},reader='model',request_id='source-analysis',related_sources=[dict(doc_id=original['doc_id'],sha256=original['sha256'],reason='Registered original')]))
                        else:
                            self.assertEqual(table['rows'][0][1]['readings']['model']['comparison'],'matches_literal')
                            self.assertEqual(table['analyses']['items'][0]['analysis_id'],'pump')
                            note=await call(session,'get_project_structure',dict(project_id=project,kind='analyses',analysis_id='source-only'))
                            self.assertTrue(note['items'][0]['current_sources']);self.assertIsNone(note['items'][0]['table_id'])
                            work=await call(session,'get_review_tasks',dict(project_id=project,task_id='resume'))
                            self.assertEqual(work['counts']['reviewed'],1);self.assertEqual(work['outcomes']['question'],1)
                            self.assertFalse(work['accepted']);self.assertEqual(work['status'],'reviewed_with_findings')
                            await call(session,'update_review_task',dict(project_id=project,task_id='resume',updates=[dict(unit_id='pump',notes='Human continuation')],expected_revision=work['revision'],request_id='human-continuation',reason='Continue from new process',actor='human'))
            self.assertIn('model',ProjectStructure(workspace,project).read(tid)['rows'][0][1]['readings'])

    async def test_structure_calculation_trace_survives_stdio_restart(self):
        try:from openpyxl import Workbook
        except ImportError:self.skipTest('readers extra missing')
        from uvyazka.ingest import scan
        from uvyazka.project_structure import ProjectStructure
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'sources';source.mkdir()
            book=Workbook();sheet=book.active;sheet['A1']=0.1;sheet['A2']=0.2;sheet['A3']='=A1+A2';book.save(source/'numbers.xlsx');book.close()
            workspace=Workspace(root/'state');workspace.create_project('p','Synthetic',source);scan(workspace,'p')
            store=ProjectStructure(workspace,'p');store.build();tid=store.catalog('tables')['items'][0]['table_id']
            params=StdioServerParameters(command=sys.executable,args=['-m','uvyazka.server'],env={**os.environ,'UVYAZKA_HOME':str(workspace.home),'PYTHONUTF8':'1'})
            async def call(session,name,**args):
                result=await session.call_tool(name,dict(project_id='p',**args));self.assertFalse(result.isError,result)
                return json.loads(next(c.text for c in result.content if c.type=='text'))
            for iteration in range(2):
                async with stdio_client(params) as (read,write):
                    async with ClientSession(read,write) as session:
                        await session.initialize()
                        if not iteration:
                            calculated=await call(session,'calculate_structure_expression',table_id=tid,expression='A3')
                            self.assertEqual(calculated['result']['value'],'0.3')
                            await call(session,'save_structure_analysis',analysis_id='calc',table_id=tid,title='Exact arithmetic',summary='Caller-selected expression.',data={'calculation':calculated},reader='model',request_id='calc-memory')
                        else:
                            note=await call(session,'get_project_structure',kind='analyses',analysis_id='calc')
                            self.assertEqual(note['items'][0]['data']['calculation'],calculated)

    async def test_folder_intake_survives_stdio_restart_and_joins_ui_project(self):
        from uvyazka.intake import ProjectIntake
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/"sources";source.mkdir()
            (source/"AR.txt").write_text("Synthetic source: area 12 m2. "*5,encoding="utf-8")
            workspace=Workspace(root/"state")
            params=StdioServerParameters(command=sys.executable,args=["-m","uvyazka.server"],
                env={**os.environ,"UVYAZKA_HOME":str(workspace.home),"PYTHONUTF8":"1"})
            async def call(session,name,arguments):
                result=await session.call_tool(name,arguments)
                self.assertFalse(result.isError,result)
                return json.loads(next(c.text for c in result.content if c.type=="text"))
            key=project=None
            for iteration in range(2):
                async with stdio_client(params) as (read,write):
                    async with ClientSession(read,write) as session:
                        await session.initialize()
                        job=await call(session,"import_project_folder",{"source_root":str(source),"name":"Shared","project_id":"shared"})
                        key=job["intake_id"];project=job["project_id"]
                        self.assertEqual(project,"shared")
                        for _ in range(100):
                            status=await call(session,"get_project_intake",{"intake_id":key})
                            if status["status"] in {"ready","partial","failed"} and not status["running"]:break
                            await asyncio.sleep(.025)
                        self.assertEqual(status["status"],"ready",status)
                        summary=await call(session,"get_project_summary",{"project_id":project,"query":"area","limit":1})
                        self.assertGreater(summary['state']['candidate_count'],0)
                        self.assertEqual(summary['items'][0]['raw_value'],'12')
                        self.assertEqual(summary['state']['remaining_blocks'],0)
                        cached=await call(session,"build_project_summary",{"project_id":project,"page_limit":1})
                        self.assertEqual(cached['processed_pages'],0)
                        if iteration:
                            self.assertTrue(job["project_reused"])
                        self.assertEqual(ProjectIntake(workspace).get(key)["project_id"],project)
            self.assertEqual(len(workspace.list_projects()["projects"]),1)

    async def test_document_tables_survive_stdio_restart(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest("readers extra not installed")
        from uvyazka.ingest import scan
        from test_document_tables import grid
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root/"sources"; source.mkdir()
            with pymupdf.open() as pdf:
                page = pdf.new_page(width=400,height=300)
                page.insert_font(fontname="fixture",fontbuffer=pymupdf.Font("cjk").buffer)
                grid(page,20,50,[["Номер помещения","Наименование","Площадь, м2"],
                                ["201","Архив","0"],["202","Склад","3–5"]],[100,100,100])
                pdf.save(source/"rooms.pdf")
            workspace = Workspace(root/"state")
            workspace.create_project("tables","Synthetic",source); scan(workspace,"tables")
            doc = workspace.find_documents("tables")["documents"][0]
            src = {"doc_id":doc["doc_id"],"sha256":doc["sha256"]}
            params = StdioServerParameters(command=sys.executable,args=["-m","uvyazka.server"],
                env={**os.environ,"UVYAZKA_HOME":str(workspace.home),"PYTHONUTF8":"1"})
            for phase in (0,1):
                with (root/f"stderr-{phase}.log").open("w+") as errlog:
                    async with stdio_client(params,errlog=errlog) as (read,write):
                        async with ClientSession(read,write) as session:
                            await session.initialize()
                            async def call(name,**args):
                                result = await session.call_tool(name,{"project_id":"tables",**args})
                                self.assertFalse(result.isError,(name,result))
                                return json.loads(next(c.text for c in result.content if c.type=="text"))
                            if phase==0:
                                indexed = await call("index_document_tables",**src)
                                self.assertEqual(indexed["pages"][0]["catalogued_tables"],1)
                                key = (await call("find_project_tables",query="Архив"))["items"][0]["table_id"]
                            else:
                                structure = await call("get_document_structure",**src)
                                self.assertEqual(structure["coverage"]["indexed_pages"],1)
                                result = await call("read_project_table",table_id=key,offset=1,limit=2)
                                self.assertEqual(result["rows"][0]["cells"][2]["text"],"0")
                                self.assertEqual(result["normalization_candidates"][0]["area_m2"],0)
                                self.assertIsNone(result["normalization_candidates"][1]["area_m2"])
                    errlog.seek(0)
                    self.assertNotIn("Failed to parse JSONRPC",errlog.read())

    async def test_drawing_work_survives_stdio_restart_and_returns_image(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest("readers extra not installed")
        from uvyazka.ingest import scan
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root/"sources"; source.mkdir()
            with pymupdf.open() as pdf:
                page = pdf.new_page(width=300, height=300)
                page.draw_rect((30, 50, 130, 150))
                pdf.save(source/"plan.pdf")
            workspace = Workspace(root/"state")
            workspace.create_project("drawing", "Synthetic", source)
            scan(workspace, "drawing")
            doc = workspace.find_documents("drawing")["documents"][0]
            scope = {"project_id": "drawing"}
            source_args = {**scope, "doc_id": doc["doc_id"], "sha256": doc["sha256"]}
            params = StdioServerParameters(command=sys.executable, args=["-m", "uvyazka.server"],
                env={**os.environ, "UVYAZKA_HOME": str(workspace.home), "PYTHONUTF8": "1"})
            # These are separate server processes, not two handles to in-memory state.
            for phase in (0, 1):
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        async def call(name, **args):
                            result = await session.call_tool(name, {**scope, **args})
                            self.assertFalse(result.isError, (name, result))
                            return result
                        if phase == 0:
                            await call("inspect_measurement_sheet", doc_id=doc["doc_id"], sha256=doc["sha256"])
                            await call("save_drawing_view", view={
                                "id": "plan", "doc_id": doc["doc_id"], "sha256": doc["sha256"], "page_number": 1,
                                "region": [10, 10, 290, 290], "name": "Plan", "kind": "plan",
                                "measurement_basis": "planar", "reason": "Synthetic view"},
                                expected_revision=0, request_id="view")
                            await call("calibrate_drawing_view", view_id="plan", expected_view_revision=1,
                                expected_calibration_revision=0, points=[[30, 50], [130, 50]],
                                length_m=10, basis="Known 10 m dimension", request_id="scale")
                            await call("measure_drawing_view", view_id="plan", view_revision=1,
                                calibration_revision=1, items=[{"id": "edge", "name": "Edge", "kind": "length",
                                "points": [[30, 50], [130, 50]], "basis": "wall_face", "reason": "Visible edge"}],
                                request_id="measure")
                        else:
                            result = await call("get_drawing_measurements", kind="measurement")
                            data = json.loads(next(c.text for c in result.content if c.type == "text"))
                            self.assertEqual(data["items"][0]["value"], 10)
                            self.assertEqual(data["items"][0]["stale_reasons"], [])
                            result = await call("render_drawing_measurements", **{k:v for k,v in source_args.items() if k != "project_id"},
                                                view_id="plan", measurement_ids=["edge"])
                            self.assertTrue(any(c.type == "image" and c.mimeType == "image/png" for c in result.content))

    async def check_protocol(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / "state"; workspace = Workspace(home); create_demo(workspace)
            parameters = StdioServerParameters(command=sys.executable, args=["-m", "uvyazka.server"], env={**os.environ, "UVYAZKA_HOME": str(home), "PYTHONUTF8": "1"})
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    self.assertEqual(len(listed.tools), 79)
                    parameters = next(tool for tool in listed.tools if tool.name == 'find_rvt_parameters')
                    self.assertIn('cursor', parameters.inputSchema['properties'])
                    self.assertIn('extraction_id', parameters.inputSchema['required'])
                    by_name = {tool.name: tool for tool in listed.tools}
                    self.assertTrue(by_name["read_evidence"].annotations.readOnlyHint)
                    self.assertTrue(by_name["get_unit_catalog"].annotations.readOnlyHint)
                    catalog = await session.call_tool("get_unit_catalog", {"dimension": "temperature"})
                    self.assertFalse(catalog.isError, catalog)
                    import json
                    data = json.loads(next(c.text for c in catalog.content if c.type == "text"))
                    celsius = next(e for e in data["units"] if e["symbol"] == "°C")
                    self.assertEqual(celsius["offset_exact"], "5463/20")
                    self.assertIn("°С", celsius["aliases"])
                    self.assertFalse(by_name["record_observations"].annotations.readOnlyHint)
                    for name, arguments in [("list_projects", {}), ("project_status", {"project_id": "demo-a"}), ("search_project", {"project_id": "demo-a", "query": "бетон"}), ("get_reconciliation", {"project_id": "demo-a"}), ("list_technology_sources", {"query": "04.02"})]:
                        result = await session.call_tool(name, arguments)
                        self.assertFalse(result.isError, (name, result))
                    fact = workspace.get_evidence_chain("demo-a", "area-design")["fact"]
                    item = {k: fact[k] for k in ["name", "group", "value", "raw_value", "unit", "basis", "sources", "entity", "property", "revision_set"]}
                    item["id"] = "mcp-recorded"
                    args = {"project_id": "demo-a", "observations": [item], "request_id": "mcp-test"}
                    result = await session.call_tool("record_observations", args)
                    self.assertFalse(result.isError, result)
                    self.assertFalse((await session.call_tool("record_observations", args)).isError)
                    self.assertEqual(workspace.get_evidence_chain("demo-a", "mcp-recorded")["fact"]["value"], "12")
                    scenario = {"id":"stdio-schedule","name":"Stdio schedule","resources":[],"operations":[{"id":"work","name":"Work","duration":10,"evidence":{"kind":"assumed","reason":"Protocol test"}}]}
                    for name, arguments in [
                        ("construction_schema", {}), ("list_project_checks", {}),
                        ("save_construction_scenario", {"project_id":"demo-a","scenario":scenario,"request_id":"stdio-save"}),
                        ("run_construction_scenario", {"project_id":"demo-a","scenario_id":"stdio-schedule"}),
                        ("save_project_graph", {"project_id":"demo-a","request_id":"stdio-graph","graph":{"entities":[{"id":"room","kind":"room","name":"Room"}]}}),
                        ("audit_project_graph", {"project_id":"demo-a"})]:
                        result = await session.call_tool(name, arguments)
                        self.assertFalse(result.isError, (name,result))
                    error = await session.call_tool("project_status", {"project_id": "nonexistent"})
                    self.assertTrue(error.isError)


if __name__ == "__main__":
    unittest.main()

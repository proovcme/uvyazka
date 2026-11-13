"""Optional external ODA converter; project sources stay read-only.

Configuration is a local owner operation, never an executable supplied by MCP.
The proprietary runtime is not distributed with this Apache-licensed package.
"""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4

from .core import connection, digest, encode, now

CONFIG = 'cad-converter.json'
VERSIONS = {'ACAD2018': b'AC1032', 'ACAD2013': b'AC1027'}
MAX_BYTES = 256 * 1024**2
SQL = 'create table if not exists cad_conversions(conversion_id text primary key,request_id text unique not null,fingerprint text not null,payload text not null)'


def assets(executable):
    root=executable.parent
    paths={executable, *root.glob('*.dll'), *root.glob('*.tx'), *root.glob('platforms/*.dll')}
    return {p.relative_to(root).as_posix():digest(p) for p in sorted(paths) if p.is_file()}


def configure(home, executable, version=''):
    executable=Path(executable).expanduser().resolve(strict=True)
    if not executable.is_file() or executable.suffix.lower() in {'.bat','.cmd','.ps1','.py'}:
        raise ValueError('Choose the external ODA File Converter executable, not a shell script')
    if 'odafileconverter' not in executable.name.casefold():
        raise ValueError('Choose ODAFileConverter or its platform package')
    if not isinstance(version,str) or len(version)>80:raise ValueError('Version label must be <=80 characters')
    value={'engine':'ODA File Converter','executable':str(executable),'version_label':version,
           'asset_sha256':assets(executable),'configured_at':now()}
    home=Path(home);home.mkdir(parents=True,exist_ok=True)
    target=home/CONFIG;target.write_text(encode(value),encoding='utf8')
    return {'configured':True,'configuration':str(target),'engine':value['engine'],'version_label':version,
            'note':'External local installation; no runtime redistributed, no AutoCAD/cloud fallback.'}


def converter_status(home):
    target=Path(home)/CONFIG
    result={'configured':False,'available':False,'engine':'ODA File Converter','autocad_required':False,
            'setup':'Install ODA separately, then uvyazka configure-cad --executable PATH',
            'scope':'DWG/DXF conversion only. Font files are not embedded; no native PDF plotting or engineering approval.'}
    if not target.is_file():return result
    if target.stat().st_size>128*1024:raise ValueError('CAD configuration exceeds 128 KiB')
    value=json.loads(target.read_text(encoding='utf8'))
    executable=Path(value.get('executable',''))
    result.update(configured=True,executable=str(executable),version_label=value.get('version_label',''))
    if not executable.is_absolute() or not executable.is_file():return {**result,'reason':'Configured converter unavailable'}
    expected=value.get('asset_sha256')
    if not isinstance(expected,dict) or not expected or any(not isinstance(v,str) or len(v)!=64 for v in expected.values()):
        raise ValueError('Invalid converter asset manifest; configure locally again')
    current=assets(executable)
    matches=current==expected
    return {**result,'available':matches,'binary_integrity':matches,'asset_sha256':current,
            'dxf_checker_available':importlib.util.find_spec('ezdxf') is not None,
            'reason':'' if matches else 'Converter files changed; verify the installation and configure again'}


def run_converter(executable, input_dir, output_dir, version, fmt, filename):
    """Fixed argv and isolated directories; no shell, no recursive folder conversion."""
    args=[str(executable),str(input_dir),str(output_dir),version,fmt,'0','0',filename]
    env=dict(os.environ)
    kwargs={}
    if os.name=='nt':
        # This Windows distribution includes qwindows, not an offscreen plugin.
        for key in ['QT_QPA_PLATFORM','QT_PLUGIN_PATH','QT_QPA_PLATFORM_PLUGIN_PATH']:env.pop(key,None)
        info=subprocess.STARTUPINFO();info.dwFlags|=subprocess.STARTF_USESHOWWINDOW;info.wShowWindow=0
        kwargs.update(startupinfo=info,creationflags=subprocess.CREATE_NO_WINDOW)
    result=subprocess.run(args,capture_output=True,timeout=120,shell=False,env=env,**kwargs)
    return {'returncode':result.returncode,'stdout':result.stdout.decode('utf8',errors='replace')[-4000:],
            'stderr':result.stderr.decode('utf8',errors='replace')[-4000:]}


class CADConversions:
    def __init__(self,workspace):self.workspace=workspace

    def _db(self,project,write=False):
        path=self.workspace.db_path(project)
        if write:
            with connection(path) as db:db.execute(SQL)
        return path

    def _read(self,project,conversion_id):
        with connection(self._db(project),readonly=True) as db:
            if not db.execute("select 1 from sqlite_master where name='cad_conversions'").fetchone():
                raise ValueError('No CAD conversions in selected project')
            row=db.execute('select payload from cad_conversions where conversion_id=?',(conversion_id,)).fetchone()
        if not row:raise ValueError('Unknown CAD conversion in selected project')
        return json.loads(row[0])

    def get(self,project,conversion_id,section='summary'):
        if section not in {'summary','validation','diagnostics'}:raise ValueError('Choose summary, validation or diagnostics')
        data=self._read(project,conversion_id)
        doc,path=self.workspace.source_record(project,data['source']['doc_id'])
        data['current_source_matches']=path.is_file() and digest(path)==data['source']['sha256']
        saved_checker=data.get('validation',{}).get('checker_revision')
        if saved_checker:
            from .cad_fidelity import checker_revision
            data['current_validation_matches']=saved_checker==checker_revision()
        else:data['current_validation_matches']=None
        for item in data.get('artifacts',[]):
            target=Path(item['path']).resolve()
            root=self.workspace.db_path(project).parent.resolve()
            if not target.is_relative_to(root) or not target.is_file() or digest(target)!=item['sha256']:
                raise ValueError('CAD artifact missing or changed; no unchanged-output claim')
        if section=='validation':return {'project_id':project,'conversion_id':conversion_id,'current_source_matches':data['current_source_matches'],'current_validation_matches':data['current_validation_matches'],**data.get('validation',{})}
        if section=='diagnostics':return {'project_id':project,'conversion_id':conversion_id,'status':data['status'],'error':data.get('error'), 'runs':data.get('runs',[]),'report_path':data.get('report_path')}
        return {k:v for k,v in data.items() if k not in {'runs','error','validation'}} | {
            'error':data.get('error'),
            'validation':{k:v for k,v in data.get('validation',{}).items() if k!='differences'},
            'difference_preview':data.get('validation',{}).get('differences',[])[:5]}

    def convert(self,project,doc_id,request_id,output_format='DWG',version='ACAD2018'):
        if not isinstance(request_id,str) or not 1<=len(request_id)<=128:raise ValueError('request_id must contain 1..128 characters')
        if output_format not in {'DWG','DXF'} or version not in VERSIONS:raise ValueError('Choose DWG/DXF and ACAD2018/ACAD2013')
        fingerprint=encode([doc_id,output_format,version])
        dbpath=self._db(project,True)
        with connection(dbpath,readonly=True) as db:
            old=db.execute('select conversion_id,fingerprint from cad_conversions where request_id=?',(request_id,)).fetchone()
        if old:
            if old['fingerprint']!=fingerprint:raise ValueError('request_id reused with different conversion input')
            return self.get(project,old['conversion_id'])
        engine=converter_status(self.workspace.home)
        if not engine['available']:raise ValueError(engine.get('reason') or engine['setup'])
        if not engine.get('dxf_checker_available'):raise ValueError('Install ezdxf for CAD round-trip validation')
        doc,source=self.workspace.source_record(project,doc_id)
        if source.suffix.lower() not in {'.dwg','.dxf'} or source.suffix.lower()=='.'+output_format.lower():
            raise ValueError('Choose a registered DXF for DWG, or DWG for DXF')
        if not source.is_file() or not 0<source.stat().st_size<=MAX_BYTES:raise ValueError('CAD source must be a file <=256 MiB')
        source_sha=digest(source)
        if doc['sha256'] and doc['sha256']!=source_sha:raise ValueError('Source changed; scan the project first')
        if not doc['sha256'] and (source.stat().st_size,source.stat().st_mtime_ns)!=(doc['size_bytes'],doc['mtime_ns']):
            raise ValueError('Source changed; scan the project first')
        conversion_id='cad-'+uuid4().hex[:16]
        folder=dbpath.parent/'cad-conversions'/conversion_id
        report={'project_id':project,'conversion_id':conversion_id,'created_at':now(),'status':'running',
            'source':{'doc_id':doc_id,'sha256':source_sha,'relative_path':doc['relative_path']},
            'engine':{k:engine[k] for k in ['engine','version_label','asset_sha256']},'output_format':output_format,'version':version,
            'original_files_modified':False,'autocad_invoked':False,'approval_status':'unreviewed',
            'artifacts':[],'runs':[],'validation':{},'limitations':['Font references are checked; external font files are not embedded.',
                'Converter does not print PDF; no engineering approval or general custom/proxy-object guarantee.']}
        with connection(dbpath) as db:
            db.execute('begin immediate')
            old=db.execute('select conversion_id,fingerprint from cad_conversions where request_id=?',(request_id,)).fetchone()
            if old:
                if old['fingerprint']!=fingerprint:raise ValueError('request_id reused with different conversion input')
                return self.get(project,old['conversion_id'])
            db.execute('insert into cad_conversions values (?,?,?,?)',(conversion_id,request_id,fingerprint,encode(report)))
        try:
            for name in ['input','output','verify']:(folder/name).mkdir(parents=True,exist_ok=False)
            staged=folder/'input'/('drawing'+source.suffix.lower());shutil.copyfile(source,staged)
            if digest(staged)!=source_sha:raise ValueError('Source changed during staging')
            self._run(report,engine,folder/'input',folder/'output',version,output_format,staged.name)
            output=folder/'output'/('drawing.'+output_format.lower())
            if not output.is_file() or not 0<output.stat().st_size<=MAX_BYTES:raise ValueError('Converter produced no bounded output')
            if output_format=='DWG':
                with output.open('rb') as stream:
                    if stream.read(6)!=VERSIONS[version]:raise ValueError('Unexpected DWG output version')
                self._run(report,engine,folder/'output',folder/'verify',version,'DXF',output.name)
                check=folder/'verify/drawing.dxf'
                if not check.is_file() or not 0<check.stat().st_size<=MAX_BYTES:raise ValueError('No bounded round-trip DXF')
                from .cad_fidelity import compare_dxf
                report['validation']=compare_dxf(staged,check)
                report['status']='converted_checked' if report['validation']['passed'] else 'converted_needs_review'
            else:
                import ezdxf
                data=ezdxf.readfile(output);audit=data.audit()
                report['validation']={'passed':False,'decoded_output':True,'audit_errors':len(audit.errors),
                    'scope':'DWG source converted to DXF; original binary object equivalence was not verified.'}
                report['status']='converted_unverified'
            if digest(source)!=source_sha or digest(staged)!=source_sha:raise ValueError('Source changed during conversion; output not accepted')
            if assets(Path(engine['executable']))!=engine['asset_sha256']:raise ValueError('Converter installation changed during conversion')
            report['artifacts']=[{'path':str(output),'sha256':digest(output),'bytes':output.stat().st_size}]
            if output_format=='DWG':report['artifacts'].append({'path':str(check),'sha256':digest(check),'bytes':check.stat().st_size,'role':'verification_dxf'})
        except Exception as exc:
            report.update(status='failed',error=str(exc)[:2000],artifacts=[])
        report['finished_at']=now();report['report_path']=str(folder/'report.json')
        folder.mkdir(parents=True,exist_ok=True)
        (folder/'report.json').write_text(encode(report),encoding='utf8')
        with connection(dbpath) as db:db.execute('update cad_conversions set payload=? where conversion_id=?',(encode(report),conversion_id))
        return self.get(project,conversion_id)

    @staticmethod
    def _run(report,engine,src,dst,version,fmt,filename):
        run=run_converter(engine['executable'],src,dst,version,fmt,filename)
        report['runs'].append(run)
        if run['returncode']!=0:raise ValueError('ODA conversion failed: '+(run['stderr'] or run['stdout'] or str(run['returncode']))[-1500:])

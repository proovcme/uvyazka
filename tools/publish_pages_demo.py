"""Publish a verified public static release to the gh-pages branch, without touching main.

Only files explicitly hashed in release.json are eligible; local projects and caches
are never discovered or copied. Run from the source checkout after build_demo_site.py.
GitHub Pages must serve gh-pages at / (repository project URL uses /uvyazka/).
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]

def verified_files(site:Path):
    site=site.resolve(strict=True)
    manifest=json.loads((site/'release.json').read_text(encoding='utf-8'))
    if manifest.get('mode')!='browser-compute-and-public-examples' or manifest.get('server_file_upload') is not False:
        raise ValueError('Only a public browser release can be published')
    revision=manifest['revision']
    if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision):raise ValueError('Invalid source revision')
    allowed={'index.html','THREE-LICENSE.txt','FONT-LICENSES.txt','SPECIFICATION-LICENSES.txt','UVYAZKA-LICENSE.txt','UVYAZKA-NOTICE.txt','assets','cad','demo','downloads','runtime'}
    paths=[]
    for name,expected in manifest['files_sha256'].items():
        relative=PurePosixPath(name)
        if '\\' in name or not relative.parts or relative.is_absolute() or '..' in relative.parts or relative.parts[0] not in allowed:
            raise ValueError('Unexpected public artifact path')
        path=site.joinpath(*relative.parts)
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(site) or not path.is_file():raise ValueError('Artifact escapes the public release')
        if path.stat().st_size>=100*1024*1024:raise ValueError('Artifact exceeds GitHub file size limit')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise ValueError('Public artifact checksum mismatch: '+name)
        paths.append((relative.as_posix(),path))
    return manifest,paths+[('release.json',site/'release.json')]

def run(*args,cwd=ROOT):
    return subprocess.check_output(list(args),cwd=cwd,text=True,encoding='utf-8').strip()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site',type=Path,default=ROOT/'.uvyazka-build/public-site/uvyazka')
    parser.add_argument('--push',action='store_true',help='Push the prepared commit to gh-pages')
    args=parser.parse_args()
    manifest,files=verified_files(args.site)
    remote=run('git','remote','get-url','origin')
    if remote not in {'https://github.com/proovcme/uvyazka.git','git@github.com:proovcme/uvyazka.git'}:
        raise ValueError('Unexpected publication repository')
    staging_root=ROOT/'.uvyazka-build';staging_root.mkdir(exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='pages-'+manifest['revision'][:12]+'-',dir=staging_root))
    run('git','init','--initial-branch=gh-pages',cwd=stage)
    run('git','config','core.autocrlf','false',cwd=stage)
    run('git','remote','add','origin',remote,cwd=stage)
    if run('git','ls-remote','--heads','origin','gh-pages',cwd=stage):
        run('git','fetch','--depth=1','origin','gh-pages',cwd=stage)
        # An empty index plus the fetched parent gives a complete replacement snapshot,
        # without checking out or deleting any previous release files.
        run('git','reset','--soft','FETCH_HEAD',cwd=stage)
    for key in ['user.name','user.email']:
        run('git','config',key,run('git','config','--get',key),cwd=stage)
    for name,source in files:
        target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
    (stage/'.nojekyll').write_text('',encoding='utf-8')
    (stage/'.gitattributes').write_text('* -text\n',encoding='utf-8')
    run('git','add','--all',cwd=stage)
    for name,source in files:
        staged=subprocess.check_output(['git','cat-file','blob',':'+name],cwd=stage)
        if hashlib.sha256(staged).digest()!=hashlib.sha256(source.read_bytes()).digest():
            raise ValueError('Git changed the artifact bytes: '+name)
    run('git','commit','-m','Publish browser demo '+manifest['revision'][:12],cwd=stage)
    if args.push:subprocess.run(['git','push','origin','HEAD:gh-pages'],cwd=stage,check=True)
    print(json.dumps({'source_revision':manifest['revision'],'deployment_commit':run('git','rev-parse','HEAD',cwd=stage),'files':len(files),'pushed':args.push,'url':'https://proovcme.github.io/uvyazka/'}))

if __name__=='__main__':main()

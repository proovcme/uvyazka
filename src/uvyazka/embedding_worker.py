"""Optional local DigUp JSON-lines provider. No network or model API client."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import struct
import subprocess
import tempfile
import threading
import atexit
from contextlib import contextmanager

from .core import encode, digest

TEXT_FILES = ('embeddinggemma-2-Q8_0.gguf', 'mmproj-embeddinggemma-2-Q8_0.gguf')


def configuration(home):
    path = Path(home)/'embedding-worker.json'
    if not path.is_file():
        return None
    if path.stat().st_size > 16*1024:
        raise ValueError('Embedding configuration exceeds 16 KiB')
    config = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(config,dict):raise ValueError('Embedding configuration must be an object')
    command = config.get('command')
    if (not isinstance(command, list) or not 1 <= len(command) <= 8
            or any(not isinstance(s, str) or not s or '\x00' in s or len(s)>2048 for s in command)):
        raise ValueError('Embedding command must be an explicit argv list')
    if not Path(command[0]).is_file():
        raise ValueError('Configured embedding executable is unavailable')
    if not isinstance(config.get('models'), str) or not Path(config['models']).is_dir():
        raise ValueError('Configured embedding model directory is unavailable')
    return config


def configure(home, executable, models):
    executable, models = Path(executable).resolve(), Path(models).resolve()
    if not executable.is_file() or not models.is_dir():
        raise ValueError('Choose an existing executable and model directory')
    if any(not (models/name).is_file() for name in TEXT_FILES):
        raise ValueError('Both pinned text and media GGUF files are required for indexing')
    path = Path(home)/'embedding-worker.json'
    path.write_text(encode(dict(command=[str(executable), 'worker'], models=str(models))),encoding='utf-8')
    return dict(configured=True, configuration=str(path), note='Local optional worker; model files are not loaded yet')


class WorkerError(ValueError):
    pass


class EmbeddingWorker:
    def __init__(self, config, *, text_only=False, timeout=90):
        self.timeout, self.sequence = timeout, 0
        # A reported model name/revision alone cannot identify locally replaced weights.
        executable=Path(config['command'][0])
        files=[executable,*sorted(executable.parent.glob('*.dll'))]
        model_files=[Path(config['models'])/name for name in TEXT_FILES]
        assets={'runtime/'+p.name:digest(p) for p in files}
        assets.update({'models/'+p.name:digest(p) for p in model_files if p.is_file()})
        self.messages = queue.Queue(maxsize=4)
        self.log = tempfile.TemporaryFile()
        command = config['command'] + (['--text-only'] if text_only else [])
        environment = {**os.environ, 'DIGUP_MODELS':config['models'], 'PYTHONUTF8':'1'}
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self.log, env=environment, shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        except BaseException:
            self.log.close();raise
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            ready = self._receive()
            if ready.get('ready') is not True:
                raise WorkerError(str(ready.get('error','Embedding worker did not start'))[:1000])
            info = ready.get('info',{})
            if type(info.get('dim')) is not int or not 1<=info['dim']<=4096:
                raise WorkerError('Invalid worker dimension')
            if any(not isinstance(info.get(k),str) or not 1<=len(info[k])<=512 for k in ('model','revision','runtime','dtype')):
                raise WorkerError('Worker must identify model, revision, runtime and dtype')
            if info.get('text_only') is not text_only:
                raise WorkerError('Worker text-only mode does not match request')
            self.info={k:info[k] for k in ('model','revision','runtime','dtype','dim')}
            self.info['asset_sha256']=assets
            self.space = hashlib.sha256(encode(self.info).encode()).hexdigest()
            self.text_only=text_only
        except BaseException:
            self.close();raise

    def _read(self):
        try:
            while True:
                raw=self.process.stdout.readline(1024*1024+1)
                if not raw:
                    self.messages.put(WorkerError('Embedding worker exited'));return
                if len(raw)>1024*1024 or not raw.endswith(b'\n'):
                    self.messages.put(WorkerError('Invalid worker reply size'));return
                self.messages.put(raw)
        except (OSError,ValueError):
            self.messages.put(WorkerError('Embedding worker pipe closed'))

    def _receive(self):
        try: raw=self.messages.get(timeout=self.timeout)
        except queue.Empty as exc: raise WorkerError('Embedding worker timed out') from exc
        if isinstance(raw,Exception):raise raw
        def reject(value):raise WorkerError('Nonfinite JSON from embedding worker')
        try: reply=json.loads(raw,parse_constant=reject)
        except (ValueError,UnicodeError) as exc:raise WorkerError('Invalid worker JSON') from exc
        if not isinstance(reply,dict):raise WorkerError('Worker reply must be an object')
        return reply

    def embed(self, inputs, *, image=False):
        if not inputs:return []
        if not isinstance(inputs,list) or len(inputs)>32 or any(not isinstance(s,str) for s in inputs):
            raise WorkerError('Embed 1–32 string inputs')
        if image and self.text_only:raise WorkerError('Image needs the full worker')
        if not image and any(len(s.encode('utf-8'))>(400 if self.text_only else 1800) for s in inputs):
            raise WorkerError('Text exceeds conservative runtime token budget')
        self.sequence+=1
        request=dict(id=self.sequence,op='image' if image else 'text',inputs=inputs)
        if image:request['budget']=560
        try:
            self.process.stdin.write((encode(request)+'\n').encode());self.process.stdin.flush()
        except (OSError,ValueError) as exc:raise WorkerError('Cannot write to embedding worker') from exc
        reply=self._receive()
        if type(reply.get('id')) is not int or reply['id']!=self.sequence or reply.get('ok') is not True:
            raise WorkerError(str(reply.get('error','Out-of-order or failed worker reply'))[:1000])
        dim=self.info['dim']
        if type(reply.get('dim')) is not int or reply['dim']!=dim or type(reply.get('count')) is not int or reply['count']!=len(inputs):
            raise WorkerError('Worker vector shape mismatch')
        errors=reply.get('errors')
        if not isinstance(errors,list) or len(errors)!=len(inputs) or any(e is not None and not isinstance(e,str) for e in errors):
            raise WorkerError('Worker must report each input error')
        try:data=base64.b64decode(reply['vectors'],validate=True)
        except (ValueError,KeyError,TypeError) as exc:raise WorkerError('Invalid worker vector encoding') from exc
        if len(data)!=4*dim*len(inputs):raise WorkerError('Worker vector byte length mismatch')
        values=struct.unpack('<'+'f'*(dim*len(inputs)),data);result=[]
        for i,error in enumerate(errors):
            if error is not None:
                result.append(dict(vector=None,error=error[:1000]));continue
            vector=values[i*dim:(i+1)*dim]
            if not all(math.isfinite(v) for v in vector):raise WorkerError('Worker produced nonfinite vector')
            norm=math.sqrt(sum(v*v for v in vector))
            if norm<1e-12:raise WorkerError('Worker produced zero vector without an error')
            result.append(dict(vector=[v/norm for v in vector],error=None))
        return result

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=2)
            except (OSError,subprocess.TimeoutExpired):
                self.process.kill();self.process.wait(timeout=5)
        try:self.process.stdout.close()
        except (OSError,ValueError):pass
        self.reader.join(timeout=1)
        self.log.close()

    def __enter__(self):return self
    def __exit__(self,*args):self.close()


_POOL = {}
_POOL_LOCK = threading.Lock()


@contextmanager
def provider(config, *, text_only=False):
    """Reuse one serialized worker, releasing its memory after two idle minutes."""
    signature=encode([config,text_only])
    with _POOL_LOCK:
        entry=_POOL.setdefault(signature,dict(lock=threading.RLock(),worker=None,timer=None))
    with entry['lock']:
        if entry['timer']:entry['timer'].cancel()
        try:
            if entry['worker'] is None or entry['worker'].process.poll() is not None:
                if entry['worker']:entry['worker'].close()
                entry['worker']=EmbeddingWorker(config,text_only=text_only)
            yield entry['worker']
        except BaseException:
            if entry['worker']:entry['worker'].close()
            entry['worker']=None
            raise
        finally:
            def release():
                with entry['lock']:
                    if entry['worker']:entry['worker'].close()
                    entry['worker']=None
            timer=threading.Timer(120,release);timer.daemon=True;entry['timer']=timer;timer.start()


def close_providers():
    for entry in list(_POOL.values()):
        with entry['lock']:
            if entry['timer']:entry['timer'].cancel()
            if entry['worker']:entry['worker'].close()
            entry['worker']=None


atexit.register(close_providers)

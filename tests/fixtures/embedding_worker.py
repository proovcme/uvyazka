"""Synthetic wire-protocol fixture, not a model or a retrieval-quality benchmark."""
import base64
import json
import math
import struct
import sys
import time

fault=next((s.split('=',1)[1] for s in sys.argv if s.startswith('--fault=')),None)
revision=next((s.split('=',1)[1] for s in sys.argv if s.startswith('--revision=')),'fixture1')
if fault=='timeout':time.sleep(3)
print(json.dumps(dict(ready=True,info=dict(model='synthetic-test',revision=revision,runtime='fixture1',dtype='fp32',dim=4,text_only='--text-only' in sys.argv))),flush=True)
for line in sys.stdin:
    request=json.loads(line)
    vectors=[]
    for text in request['inputs']:
        text=text.lower()
        row=([1,0,0,0] if any(s in text for s in ('насос','повысит')) or request['op']=='image' else
             [0,1,0,0] if any(s in text for s in ('вентил','воздух')) else
             [0,0,1,0] if any(s in text for s in ('кабел','электр')) else [0,0,0,1])
        if fault=='nan':row[0]=float('nan')
        vectors.extend(row)
    reply=dict(id=request['id']+int(fault=='id'),ok=True,dim=4,count=len(request['inputs']),
               errors=[None]*len(request['inputs']),vectors=base64.b64encode(struct.pack('<'+'f'*len(vectors),*vectors)).decode())
    if fault=='shape':reply['dim']=8
    print(json.dumps(reply),flush=True)

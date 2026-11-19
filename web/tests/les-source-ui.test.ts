import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {showLesSource} from '../src/les-source.ts';
test('source dialog reads every Unicode portion and never turns changed-source errors into properties',async()=>{
  const window=new Window({url:'http://127.0.0.1:8765/simulation/'});
  const previous={document:globalThis.document,location:globalThis.location,fetch:globalThis.fetch};
  Object.assign(globalThis,{document:window.document,location:window.location});
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  const target={project:'example',dataset:'snapshot',object:'42',sha256:'a'.repeat(64)};
  const text='{"object_id":"42","native_id":"42","section":"elements","name":"Щит 🌲","properties":{"power":0,"missing":null,"id":9007199254740993,"literal":"<script>unsafe</script>"}}';
  const offsets:number[]=[];let stale=false;
  globalThis.fetch=async(raw)=>{
    const q=new URL(String(raw)).searchParams;const offset=Number(q.get('offset'));offsets.push(offset);
    const fragment=Array.from(text).slice(offset,offset+37).join('');const next=offset+Array.from(fragment).length;
    return new Response(JSON.stringify({project_id:target.project,dataset_id:target.dataset,object_id:target.object,source:{sha256:target.sha256},
      freshness:{status:stale?'needs_refresh':'content_hash_matches'},text:fragment,total_chars:Array.from(text).length,next_offset:next<Array.from(text).length?next:null}));
  };
  try{
    let focused=false;
    await showLesSource(target,()=>null,()=>{focused=true;});
    const content=window.document.body.textContent;
    assert.ok(content.includes('Щит 🌲')&&content.includes('9007199254740993')&&content.includes('Не задано'));
    assert.equal(window.document.querySelector('script'),null);assert.equal(focused,false);
    assert.deepEqual(offsets,[0,37,74,111,148]);
    window.document.querySelector('dialog')!.remove();stale=true;offsets.length=0;
    await showLesSource(target,()=>null,()=>{focused=true;});
    assert.ok(window.document.querySelector('[role="alert"]')!.textContent!.includes('Оригинал изменился'));
    assert.equal(window.document.querySelector('dl'),null);assert.equal(focused,false);assert.deepEqual(offsets,[0]);
  }finally{Object.assign(globalThis,previous);await window.happyDOM.close();}
});

test('file link opens the checked drawing without choosing an element',async()=>{
  const window=new Window({url:'http://127.0.0.1:8765/simulation/'});
  const previous={document:globalThis.document,location:globalThis.location,fetch:globalThis.fetch};
  Object.assign(globalThis,{document:window.document,location:window.location});
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  const target={project:'example',dataset:'snapshot',object:'@dataset',sha256:'a'.repeat(64)};
  const text=JSON.stringify({dataset_id:target.dataset,object_count:2});
  let calls=0, stale=false;
  globalThis.fetch=async raw=>{
    assert.equal(new URL(String(raw)).searchParams.get('verify_source'),'1');
    return new Response(JSON.stringify({project_id:target.project,dataset_id:target.dataset,object_id:target.object,
      source:{sha256:target.sha256,format:'dxf',relative_path:'Drawing.dxf'},
      freshness:{status:stale?'needs_refresh':'content_hash_matches'},text,total_chars:text.length,next_offset:null}));
  };
  const presentation={openDrawing:async(link:typeof target,source:Record<string,unknown>,record:unknown)=>{
    assert.deepEqual(link,target);assert.equal(source.relative_path,'Drawing.dxf');assert.equal(record,undefined);calls++;
  }};
  try{
    await showLesSource(target,()=>null,()=>assert.fail('unrequested focus'),presentation);
    assert.equal(calls,1);
    assert.equal(window.document.querySelector('dialog'),null);
    stale=true;
    await showLesSource(target,()=>null,()=>assert.fail('unrequested focus'),presentation);
    assert.equal(calls,1);
    assert.match(window.document.querySelector('[role="alert"]')!.textContent!,/Оригинал изменился/);
  }finally{Object.assign(globalThis,previous);await window.happyDOM.close();}
});
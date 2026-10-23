import test from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {modelTreePanel} from '../src/model-tree-panel.ts';
import {ModelVisibility} from '../src/model-visibility.ts';
import {recordMatches} from '../src/rvt-navigation.ts';
import type {RvtDocument,NativeRecord} from '../src/rvt-document.ts';
import type {ModelPackage} from '../src/model.ts';
const record=(id:string,name:string,kind:NativeRecord['kind']='view',cls='DBViewPlan'):NativeRecord=>({identity:{element_id:id},kind,class_name:cls,status:'partial',source:{stream:'Partitions/1'},graph:{objects:[{class_name:cls,fields:{m_viewName:name,...(cls==='DBViewDrafting'?{m_sheetNumber:'АР-1'}:{})}}],edges:[]}});
const doc=(hash:string,name:string,records:NativeRecord[]):RvtDocument=>({schema_version:1,schema_sha256:'a'.repeat(64),source:{sha256:hash,filename:name,size_bytes:42},status:'partial',records,summary:{},clipped_records:0,evaluated_schedule_body_available:false});

test('federated RVT navigation attaches by source hash, preserves same IDs and separates unbound catalogue',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('div');document.body.append(host);const picked:string[]=[];
 const tree=modelTreePanel(host,new ModelVisibility(),{select:()=>assert.fail('document is not a physical element'),show:()=>assert.fail('no document visibility'),isolate:()=>{},document:(d,r)=>picked.push(d.source!.sha256+':'+r.identity.element_id)});
 const a=doc('a'.repeat(64),'a.rvt',[record('9007199254740993','План А')]),b=doc('b'.repeat(64),'b.rvt',[record('9007199254740993','План Б')]),other=doc('c'.repeat(64),'other.rvt',[record('7','Чужой лист','view','DBViewDrafting')]);
 const model={source:{sha256:'f'.repeat(64),filename:'Federation'},storeys:[],elements:[],federation:{members:[{instance_id:'a',label:'a.rvt',source_sha256:a.source!.sha256},{instance_id:'b',label:'b.rvt',source_sha256:b.source!.sha256}]}} as unknown as ModelPackage;
 tree.render(model,[],null,true,'q','categories',[a,b,other],'revit:9007199254740993');
 const roots=host.querySelectorAll('.branch-model');assert.equal(roots.length,3);assert.equal(roots[0].querySelector('.document-item')!.textContent!.includes('План А'),true);assert.equal(roots[1].querySelector('.document-item')!.textContent!.includes('План Б'),true);
 assert.equal(roots[0].querySelector('.branch-document input'),null);assert.match(roots[2].textContent!,/без привязки/);
 host.querySelectorAll<HTMLButtonElement>('.document-item')[1].click();assert.deepEqual(picked,['b'.repeat(64)+':9007199254740993']);
 assert.equal(recordMatches(a.records[0],'revit:9007199254740994'),false);
});

test('catalogue without geometry remains navigable and large groups are paged',t=>{
 const win=new Window();t.after(()=>win.happyDOM.close());globalThis.document=win.document as unknown as Document;
 const host=document.createElement('div');document.body.append(host);
 const data=doc('a'.repeat(64),'no-geometry.rvt',Array.from({length:1201},(_,i)=>record(String(i),'Вид '+i)));
 const tree=modelTreePanel(host,new ModelVisibility(),{select:()=>{},show:()=>{},isolate:()=>{}});
 tree.render(null,[],null,true,'q','categories',[data],'Вид');assert.equal(host.querySelectorAll('.document-item').length,50);
 host.querySelector<HTMLButtonElement>('.tree-more')!.click();assert.equal(host.querySelectorAll('.document-item').length,100);
 tree.render(null,[],null,true,'q2','categories',[data],'#1200');assert.equal(host.querySelectorAll('.document-item').length,1);assert.equal(host.querySelector<HTMLElement>('.document-item')!.dataset.recordId,'1200');
});

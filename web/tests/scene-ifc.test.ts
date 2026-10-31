import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {exportSceneIfc,stepUnicodeWriter} from '../src/scene-ifc.ts';import {sceneIfcFixture} from './scene-ifc-fixture.ts';
const require=createRequire(import.meta.url),web=require('web-ifc'),api=new web.IfcAPI();await api.Init();
const bytes=(result:any)=>new Uint8Array(Buffer.concat(result.chunks));
function ids(model:number,type:number){const rows=api.GetLineIDsWithType(model,type,true);return Array.from({length:rows.size()},(_,i)=>rows.get(i));}
function values(model:number,name:string){const set=ids(model,web.IFCPROPERTYSET).map(id=>api.GetLine(model,id)).find(set=>set.Name.value===name);assert.ok(set,name);return Object.fromEntries(set.HasProperties.map((ref:any)=>{const p=api.GetLine(model,ref.value);return[p.Name.value,p.ListValues?p.ListValues.map((v:any)=>v.value).join(''):p.NominalValue?.value??null];}));}
test('scene IFC preserves long IDs, unknown/zero/false values, Unicode, all geometry and source grouping',async()=>{
 const {model,binary}=await sceneIfcFixture(),result=await exportSceneIfc(model,binary,web,api,{detailedSources:true}),read=api.OpenModel(bytes(result));
 try{assert.equal(api.GetModelSchema(read),'IFC4');assert.equal(result.report.products,2);assert.equal(result.report.groups,1);assert.equal(result.report.lineSegments,1);
  const props=values(read,'Engineering');assert.equal(props.Zero,0);assert.equal(props.False,false);assert.equal(props.Empty,'');assert.equal(props.Unknown,null);assert.equal(props.LongText,'Источник 😀'.repeat(1800));assert.deepEqual(JSON.parse(props.Data as string),{Label:'Проверка',Ids:['9007199254740993'],Flag:false});assert.equal(props.Literal,"');ENDSEC;#1=IFCPROXY();");
  assert.equal(values(read,'Revit Identity').ElementId,'9007199254740993');assert.equal(ids(read,web.IFCBUILDINGELEMENTPROXY).length,2);assert.equal(ids(read,web.IFCPOLYLINE).length,1);assert.equal(ids(read,web.IFCSYSTEM).length,1);assert.equal(values(read,'Uvyazka_System').ConnectivityVerified,false);
  const curve=api.GetLine(read,ids(read,web.IFCPOLYLINE)[0]);assert.equal(curve.Points.length,2);
  const allRoots=ids(read,web.IFCROOT);assert.ok(allRoots.length>10);const globalIds=allRoots.map(id=>api.GetLine(read,id).GlobalId.value);assert.equal(new Set(globalIds).size,globalIds.length);assert.ok(globalIds.every(id=>/^[0-3][0-9A-Za-z_$]{21}$/.test(id)));
 }finally{api.CloseModel(read);}
});
test('an explicit visible subset does not become whole-scene export; properties can be omitted but identity remains',async()=>{
 const {model,binary}=await sceneIfcFixture(),result=await exportSceneIfc(model,binary,web,api,{ids:['ifc-source:pump'],properties:false}),read=api.OpenModel(bytes(result));
 try{assert.equal(result.report.scope,'subset');assert.equal(result.report.products,1);assert.equal(ids(read,web.IFCBUILDINGELEMENTPROXY).length,1);assert.equal(ids(read,web.IFCPROPERTYSET).map(id=>api.GetLine(read,id)).some(p=>p.Name.value==='Engineering'),false);assert.equal(values(read,'Revit Identity').ElementId,'9007199254740993');}finally{api.CloseModel(read);}
});
test('invalid geometry, unknown selections and export budget failure never produce a successful partial IFC',async()=>{
 const {model,binary}=await sceneIfcFixture();await assert.rejects(exportSceneIfc(model,binary,web,api,{ids:['missing']}),/неизвестные/);await assert.rejects(exportSceneIfc(model,binary,web,api,{ids:[]}),/нет геометрии/);await assert.rejects(exportSceneIfc(model,binary,web,api,{maxBytes:100}),/бюджет/);
 const mesh=model.elements.find(e=>e.mesh)!.mesh!;new Uint32Array(binary,mesh.index_byte_offset,mesh.index_count)[0]=mesh.vertex_count;await assert.rejects(exportSceneIfc(model,binary,web,api),/Геометрия/);
});

test('STEP supplementary Unicode conversion preserves literals across every callback boundary',()=>{
 const input=String.raw`'\X2\041DD83DDE00\X0\' 'literal \\X2\\D83DDE00\\X0\\'`;
 const expected=String.raw`'\X4\0000041D0001F600\X0\' 'literal \\X2\\D83DDE00\\X0\\'`;
 for(let cut=0;cut<=input.length;cut++){const parts:string[]=[];const write=stepUnicodeWriter(t=>parts.push(t));write(input.slice(0,cut));write(input.slice(cut),true);assert.equal(parts.join(''),expected);}
 const write=stepUnicodeWriter(()=>{});assert.throws(()=>write(String.raw`\X2\D800\X0\!`.slice(0,-1),true),/символ/);
});

test('source unit metadata never scales already-normalized metre geometry twice',async()=>{
 const {model,binary}=await sceneIfcFixture();model.coordinate_system.length_to_m=.3048;
 const a=await exportSceneIfc(model,binary,web,api),read=api.OpenModel(bytes(a));
 try{const list=api.GetLine(read,ids(read,web.IFCCARTESIANPOINTLIST3D)[0]);const mesh=model.elements.find(e=>e.mesh&&e.mesh.primitive!=='lines')!.mesh!;const positions=new Float32Array(binary,mesh.position_byte_offset,mesh.vertex_count*3);assert.deepEqual(list.CoordList.map((p:any[])=>p.map(v=>v.value)),Array.from({length:mesh.vertex_count},(_,i)=>Array.from(positions.slice(i*3,i*3+3))));}finally{api.CloseModel(read);}
});

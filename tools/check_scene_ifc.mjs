// Synthetic scene only. Generate an IFC plus its independently checked oracle.
import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';
import {sceneIfcFixture} from '../web/tests/scene-ifc-fixture.ts';
import {exportSceneIfc} from '../web/src/scene-ifc.ts';
const require=createRequire(new URL('../web/package.json',import.meta.url)),web=require('web-ifc'),api=new web.IfcAPI();await api.Init();
const out=path.resolve(process.argv[2]??'.uvyazka-build/scene-ifc-check');await fs.mkdir(out,{recursive:true});
const scene=await sceneIfcFixture(),result=await exportSceneIfc(scene.model,scene.binary,web,api,{detailedSources:true});
await fs.writeFile(path.join(out,'synthetic.ifc'),Buffer.concat(result.chunks));
const expected=scene.model.elements.map(e=>{
 const points=[];if(e.mesh){const v=new Float32Array(scene.binary,e.mesh.position_byte_offset,e.mesh.vertex_count*3),indices=new Uint32Array(scene.binary,e.mesh.index_byte_offset,e.mesh.index_count);for(const i of new Set(indices))points.push([v[i*3],v[i*3+1],v[i*3+2]].map((n,k)=>n+scene.model.coordinate_system.render_origin_m[k]));}
 return {id:e.id,name:e.name,revit_id:e.revit?.element_id??null,properties:e.property_sets,points};
});
await fs.writeFile(path.join(out,'expected.json'),JSON.stringify({expected,report:result.report},null,2));console.log('Synthetic IFC scene generated');

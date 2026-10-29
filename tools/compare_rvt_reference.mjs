/** Audit both RVT routes against separately supplied author IFC exports in the public RE1 corpus.
 * node --experimental-strip-types tools/compare_rvt_reference.mjs [--case Mechanical] [--output path]
 * Reads local fixtures/runtime; writes diagnostics only, never changes the source models.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {importIfc} from '../web/src/browser-ifc.ts';
import {importRvtDirect} from '../web/src/browser-rvt-direct.ts';
import {elementIdentity} from '../web/src/element-identity.ts';
import {bboxDifference,worldMesh,sampledSurfaceDistance} from './lib/geometry-reference.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const runtime=path.resolve(option('--runtime',path.join(root,'.uvyazka-build/public-site/uvyazka/runtime')));
const output=path.resolve(option('--output',path.join(root,'.uvyazka-build/rvt-reference/report.json')));
const cases=option('--case',null)?[option('--case')]:['Architecture','Mechanical','Electrical','Plumbing'];
if(cases.some(name=>!['Architecture','Mechanical','Electrical','Plumbing'].includes(name)))throw Error('Unknown curated RE1 case');
const manifest=JSON.parse(await fs.readFile(path.join(root,'tools/browser-fixtures.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(name){
 const row=manifest.find(row=>row.name===name);if(!row)throw Error('Fixture is not in the public manifest');
 const bytes=await fs.readFile(path.join(root,'.uvyazka-build/browser-fixtures',name));
 if(bytes.length!==row.size||sha(bytes)!==row.sha256)throw Error('Fixture hash/size differs: '+name);
 return {bytes,source:row};
}
const module=await import(pathToFileURL(path.join(runtime,'rvt/uvyazka_rvt_browser.js')));
await module.default({module_or_path:await fs.readFile(path.join(runtime,'rvt/uvyazka_rvt_browser_bg.wasm'))});
const require=createRequire(import.meta.url),{IfcAPI}=require(path.join(root,'web/node_modules/web-ifc/web-ifc-api-node.js'));
const api=new IfcAPI();await api.Init();
const schemas=JSON.parse(await fs.readFile(path.join(runtime,'ifc-hierarchy.json'),'utf8'));
const threshold=.01;
function index(model){
 const rows=new Map();let unidentified=0;
 for(const element of model.elements){
  if(element.role!=='element')continue;
  const id=elementIdentity(element).element_id;
  if(!id){unidentified++;continue;}
  rows.set(id,[...(rows.get(id)??[]),element]);
 }
 return {rows,unidentified};
}
function compare(observed,reference){
 const a=index(observed.model),b=index(reference.model),rows=[];
 for(const id of new Set([...a.rows.keys(),...b.rows.keys()])){
  const x=a.rows.get(id)??[],y=b.rows.get(id)??[];
  if(x.length!==1||y.length!==1){rows.push({element_id:id,state:x.length>1||y.length>1?'ambiguous_identity':'not_in_both_read_sets',observed_records:x.length,reference_records:y.length});continue;}
  const left=x[0],right=y[0],row={element_id:id,state:'compared',observed_class:left.class,reference_class:right.class,observed_name:left.name,reference_name:right.name,observed_geometry_evidence:left.geometry_evidence,reference_global_id:right.global_id,geometry:[!!left.mesh,!!right.mesh]};
  if(left.mesh&&right.mesh){
   row.bounds=bboxDifference(left.mesh,right.mesh);
   row.surface=sampledSurfaceDistance(worldMesh(observed.model,observed.binary,left),worldMesh(reference.model,reference.binary,right));
   row.observed_triangles=left.mesh.index_count/3;row.reference_triangles=right.mesh.index_count/3;
   row.state=!row.surface?'geometry_unavailable':row.bounds.max_m>threshold||row.surface.max_m>threshold?'difference_over_diagnostic_threshold':'within_sampled_threshold';
  }else row.state='geometry_unavailable';
  rows.push(row);
 }
 const matched=rows.filter(row=>row.bounds),differences=rows.filter(row=>row.state==='difference_over_diagnostic_threshold');
 return {state:!matched.length?'not_comparable':differences.length?'differences_observed':'no_differences_over_threshold_in_compared_subset',
  compared:matched.length,differences:differences.length,unmatched:rows.filter(row=>row.state==='not_in_both_read_sets').length,
  ambiguous:rows.filter(row=>row.state==='ambiguous_identity').length,unidentified:{observed:a.unidentified,reference:b.unidentified},
  max_bbox_delta_m:matched.length?Math.max(...matched.map(row=>row.bounds.max_m)):null,
  max_sampled_surface_delta_m:matched.some(row=>row.surface)?Math.max(...matched.filter(row=>row.surface).map(row=>row.surface.max_m)):null,rows};
}
const results=[];
for(const name of cases){
 const pair={case:name,source_pairing:'curated author file names; equality of source revisions is not independently established'};
 try{
  const rvt=await fixture('RE1-'+name+'.rvt'),ifc=await fixture('RE1-'+name+'.ifc');
  pair.sources={rvt:rvt.source,ifc:ifc.source};
  const reference=await importIfc(api,ifc.bytes,ifc.source.name,ifc.source.sha256,schemas,()=>{});
  for(const route of ['direct','ifc']){
   try{
    const started=performance.now();let observed;
    if(route==='direct')observed=await importRvtDirect(module.extractRvtDirectScene(rvt.bytes),{filename:rvt.source.name,sha256:rvt.source.sha256,size_bytes:rvt.bytes.length});
    else{
     const converted=module.convertRvtBytes(rvt.bytes);if(!converted.ifc_step)throw Error(converted.quality_error??'RVT conversion has no geometry');
     const bytes=new TextEncoder().encode(converted.ifc_step);
     observed=await importIfc(api,bytes,rvt.source.name,sha(bytes),schemas,()=>{},true);
    }
    pair[route]={read_seconds:(performance.now()-started)/1000,...compare(observed,reference)};
    console.log(JSON.stringify({case:name,route,...Object.fromEntries(Object.entries(pair[route]).filter(([key])=>key!=='rows'))}));
   }catch(error){pair[route]={state:'reader_error',error:String(error)};process.exitCode=2;console.log(JSON.stringify({case:name,route,...pair[route]}));}
  }
 }catch(error){pair.error=String(error);process.exitCode=2;console.log(JSON.stringify({case:name,error:pair.error}));}
 results.push(pair);
}
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,JSON.stringify({schema_version:1,diagnostic_threshold_m:threshold,acceptance_tolerance:false,coordinate_alignment_fitted:false,
 identity_rule:'one exact Revit ElementId on each side of the explicitly selected pair; names/positions never used to match',
 limitations:['Author IFC is an independent export, not a guaranteed same-revision oracle.','Graphics owners are not physical counts.','Surface sampling is not a full Hausdorff/topology/solid validity test.','A small difference does not certify Revit compatibility or full coverage.'],results},null,2));

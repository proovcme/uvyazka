// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone local process. The Apache Python core consumes its JSON output.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Dwg_File_Type,LibreDwg} from '@mlightcad/libredwg-web';

// JSON.stringify permits lone UTF-16 units, but Python/SQLite/MCP require
// Unicode scalar values. Preserve their exact spelling and provenance rather
// than dropping an entire drawing or pretending that the text was recovered.
export function transportSafeMetadata(value, diagnostics, path=[]){
 if(typeof value==='string'){
  const safe=value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
   unit=>'\\u'+unit.charCodeAt(0).toString(16).padStart(4,'0'));
  if(safe!==value)diagnostics.push({kind:'invalid_utf16',path,original_json:JSON.stringify(value),
   representation:'Unpaired UTF-16 units shown as literal \\uXXXX; original text is not recovered.'});
  return safe;
 }
 if(Array.isArray(value))return value.map((item,index)=>transportSafeMetadata(item,diagnostics,[...path,index]));
 if(value!==null&&typeof value==='object'){
  const result=Object.create(null);
  for(const [key,item] of Object.entries(value)){
   // Object keys form addresses: never silently rename or merge them.
   if(!key.isWellFormed())throw Error('CAD metadata contains an invalid UTF-16 property key');
   result[key]=transportSafeMetadata(item,diagnostics,[...path,key]);
  }
  return result;
 }
 return typeof value==='bigint'?value.toString():value;
}

export function metadataEntity(entity,diagnostics,index){
 if(entity.type!=='OLE2FRAME'||!Object.hasOwn(entity,'binaryData'))return entity;
 const {binaryData,...metadata}=entity;
 // An embedded document is not a decoded engineering property. Keep its
 // identity without copying megabytes of opaque binary into every API row.
 const serialized=JSON.stringify(binaryData);
 const descriptor={state:'not_decoded',reason:'Embedded OLE payload excluded from metadata',
  declared_size_bytes:entity.dataSize??null,
  serialized_chars:serialized.length,
  serialized_sha256:createHash('sha256').update(serialized).digest('hex'),
  hash_basis:'UTF-8 JSON.stringify of decoder binaryData; not original DWG bytes'};
 diagnostics.push({kind:'embedded_payload_not_decoded',path:['sections','elements',index,'binaryData'],handle:entity.handle??null,...descriptor});
 return {...metadata,binaryData:descriptor};
}

async function main(){
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node read-data.mjs input.dwg output.json');
const data=fs.readFileSync(input),reader=await LibreDwg.create();
const pointer=reader.dwg_read_data(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),Dwg_File_Type.DWG);
if(!pointer)throw Error('LibreDWG did not decode the file');
try{
 const db=reader.convert(pointer);
 const blocks=db.tables.BLOCK_RECORD?.entries??[];
 const sections={elements:db.entities??[],layers:db.tables.LAYER?.entries??[],blocks:blocks.map(({entities,...block})=>block),layouts:db.objects.LAYOUT??[]};
 const handles=new Set(sections.elements.map(e=>e.handle).filter(Boolean));
 for(const block of blocks)for(const entity of block.entities??[])if(!entity.handle||!handles.has(entity.handle)){sections.elements.push(entity);if(entity.handle)handles.add(entity.handle);}
 const diagnostics=['Decoded CAD subset; no referenced file is opened'];
 sections.elements=sections.elements.map((entity,index)=>metadataEntity(entity,diagnostics,index));
 const metadata=transportSafeMetadata({contract:'UvyazkaCadMetadata',version:1,sections,units:{INSUNITS:db.header.$INSUNITS??db.header.INSUNITS??null}},diagnostics);
 const text=JSON.stringify({...metadata,diagnostics});
 if(Buffer.byteLength(text)>128*1024**2)throw Error('CAD metadata output budget exceeded');
 fs.writeFileSync(output,text);process.stdout.write('CAD metadata saved\n');
}finally{reader.dwg_free(pointer);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();

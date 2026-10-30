// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone local process. The Apache Python core consumes its JSON output.
import fs from 'node:fs';
import {Dwg_File_Type,LibreDwg} from '@mlightcad/libredwg-web';
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
 const text=JSON.stringify({contract:'UvyazkaCadMetadata',version:1,sections,units:{INSUNITS:db.header.$INSUNITS??db.header.INSUNITS??null},diagnostics:['Decoded CAD subset; no referenced file is opened']},(_,value)=>typeof value==='bigint'?value.toString():value);
 if(Buffer.byteLength(text)>128*1024**2)throw Error('CAD metadata output budget exceeded');
 fs.writeFileSync(output,text);process.stdout.write('CAD metadata saved\n');
}finally{reader.dwg_free(pointer);}

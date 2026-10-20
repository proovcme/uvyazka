import test from 'node:test';
import assert from 'node:assert/strict';
import {category,identifier,linked,schedule,sheetPlacements,viewOrientation,scheduleCsv,scheduleGrids,savedCellState} from '../src/rvt-document.ts';
import type {NativeRecord} from '../src/rvt-document.ts';
import type {SavedCell} from '../src/rvt-document.ts';
function record(class_name='DBViewSchedule'):NativeRecord{return {identity:{element_id:12},class_name,kind:'schedule',status:'complete',source:{},graph:{objects:[{class_name,fields:{}}],edges:[]}};}
function fixture(){const r=record(),g=r.graph!;g.objects[0].fields={m_pSchema:{offset:10,pointer_token:1},m_pData:{offset:11,pointer_token:1}};
 g.objects.push({class_name:'ScheduleSchema',fields:{m_pFields:[{offset:20,pointer_token:1}],m_fieldIds:[{m_id:7}]}},{class_name:'ScheduleField',fields:{m_columnHeading:'Количество',m_hidden:false}},{class_name:'ScheduleData',fields:{m_SectionData:[{offset:30,pointer_token:1}]}},{class_name:'TableSectionData',fields:{m_index:1,m_tableCells:[{offset:40,pointer_token:1}]}},{class_name:'TableRowCellData',fields:{m_arrCells:[{offset:50,pointer_token:1}]}},{class_name:'TableCellData',fields:{m_row:3,m_column:2,m_text:'=1+1'}},{class_name:'TableCellData',fields:{m_text:'unrelated'}});
 g.edges=[{source_object_index:0,pointer_offset:10,target_object_index:1},{source_object_index:0,pointer_offset:11,target_object_index:3},{source_object_index:1,pointer_offset:20,target_object_index:2},{source_object_index:3,pointer_offset:30,target_object_index:4},{source_object_index:4,pointer_offset:40,target_object_index:5},{source_object_index:5,pointer_offset:50,target_object_index:6}];return r;}
test('schedule follows explicit edges; never harvests unrelated cells or evaluates expressions',()=>{const r=fixture(),s=schedule(r);assert.equal(s.columns[0].id,'7');assert.equal(s.columns[0].properties.m_hidden,false);assert.equal(s.cells.length,1);assert.equal(s.cells[0].row,3);assert.equal(s.cells[0].text,'=1+1');assert.deepEqual(s.cells[0].path,['graph','objects',6,'fields']);assert.match(scheduleCsv(r),/'=1\+1/);});
test('unresolved and ambiguous pointers stay unavailable',()=>{const r=fixture();r.graph!.edges.push({...r.graph!.edges[0],target_object_index:2});assert.equal(linked(r,0,{offset:10,pointer_token:1}),null);assert.equal(schedule(r).columns.length,0);assert.ok(schedule(r).issues.length);r.graph=null;assert.equal(schedule(r).cells.length,0);});
test('classification keeps templates separate and requires a real sheet number',()=>{const r=record('DBViewDrafting');r.kind='view';assert.equal(category(r),'other');r.graph!.objects[0].fields.m_sheetNumber='A-01';assert.equal(category(r),'sheets');r.graph!.objects[0].fields.m_isTemplate=true;assert.equal(category(r),'templates');});
test('sheet contents use drawing IDs, never similar names',()=>{const s=record('DBViewDrafting'),p=record('Viewport');s.graph!.objects[0].fields.m_dbDrawingId={m_id:{m_id64:123}};p.kind='placement';p.graph!.objects[0].fields.m_dbDrawingId={m_id:123};assert.deepEqual(sheetPlacements(s,[p]),[p]);p.graph!.objects[0].fields.m_dbDrawingId={m_id:-1};assert.deepEqual(sheetPlacements(s,[p]),[]);assert.equal(identifier({m_id64:0}),'0');});
test('orientation accepts only valid non-template view direction pairs',()=>{const r=record('DBView3d'),f=r.graph!.objects[0].fields;r.kind='view';f.m_viewDir=[0,0,1];f.m_vertDir=[0,1,0];assert.ok(viewOrientation(r));f.m_vertDir=[0,0,2];assert.equal(viewOrientation(r),null);f.m_vertDir=[0,1,0];f.m_isTemplate=true;assert.equal(viewOrientation(r),null);});
test('sheet includes schedule owner links and excludes its own viewport',()=>{
 const s=record('DBViewDrafting'),p=record('ScheduleInstance'),own=record('Viewport');
 s.graph!.objects[0].fields.m_dbDrawingId={m_id:999};p.kind=own.kind='placement';
 p.graph!.objects[0].fields={m_ownerDBViewId:{m_id:12},m_scheduleId:{m_id:99}};
 own.graph!.objects[0].fields={m_dbViewId:{m_id:12},m_dbDrawingId:{m_id:999}};
 assert.deepEqual(sheetPlacements(s,[p,own]),[p]);
});
test('saved grid preserves sparse coordinates, sections, conflicts and unpositioned evidence',()=>{
 const base=schedule(fixture()).cells[0];
 const cell=(section:number,row:number|null,column:number|null,text:string|null):SavedCell=>({...base,section,row,column,text});
 const input=[cell(1,1000000000,1000000000,'large'),cell(1,0,2,'a'),cell(1,0,2,'b'),cell(1,null,2,'unknown'),cell(1,-1,2,'invalid'),cell(0,0,2,'heading')];
 const grids=scheduleGrids(input);
 assert.equal(grids.length,2);assert.deepEqual(grids[0].rows,[0,1000000000]);assert.deepEqual(grids[0].columns,[2,1000000000]);
 assert.equal(grids[0].cells.size,2);assert.deepEqual(grids[0].cells.get('0:2'),input.slice(1,3));assert.deepEqual(grids[0].unpositioned,input.slice(3,5));
 assert.equal(grids[1].cells.get('0:2')?.[0].text,'heading');
});
test('cell states distinguish absent evidence, unreadable text, saved empty text, zero and conflicts',()=>{
 const base=schedule(fixture()).cells[0];
 assert.equal(savedCellState([]),'missing');assert.equal(savedCellState([{...base,text:null}]),'unreadable');
 assert.equal(savedCellState([{...base,text:''}]),'empty');assert.equal(savedCellState([{...base,text:'0'}]),'text');
 assert.equal(savedCellState([base,{...base}]),'conflict');
});

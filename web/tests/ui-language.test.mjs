import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Window} from 'happy-dom';
import {userMessage,progressMessage,displayClass,addDiagnostics,sourceFormatLabel} from '../src/ui-language.ts';
import {propertySections} from '../src/property-sections.ts';
import {fixture} from './reliability-fixture.ts';
const raw='graph TableCellStyle starts12345: TableCellStyle.m_borderRightLineStyle: native field value budget exceeded (100000)';
function surface(element){const clone=element.cloneNode(true);for(const detail of [...clone.querySelectorAll('details:not([open])')]){const summary=detail.querySelector(':scope > summary');detail.replaceChildren(...(summary?[summary]:[]));}return clone.textContent;}
function dom(t){const win=new Window({url:'http://localhost/uvyazka/?project=synthetic'});const keys=['document','localStorage','Option','Event','CustomEvent'],old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));for(const k of keys)globalThis[k]=win[k];globalThis.Option=function(text,value){const option=win.document.createElement('option');option.textContent=text;option.value=value;return option;};win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};t.after(()=>{for(const k of keys)globalThis[k]=old[k];win.happyDOM.close();});return win;}
async function moduleAt(entry){const result=await build({entryPoints:[entry],bundle:true,format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));}
test('technical failures become concise messages without changing meaningful engineering text',()=>{
 assert.doesNotMatch(userMessage(raw),/graph|TableCellStyle|100000|m_border/);assert.equal(userMessage('Выберите два элемента.'),'Выберите два элемента.');assert.equal(userMessage('Мощность: 0 кВт'),'Мощность: 0 кВт');
 assert.equal(progressMessage('Данные NWD','Поток m_table: обработано 200 фрагментов'),'Чтение данных модели…');assert.equal(displayClass('Класс RVT: FamilyInstance'),'Элемент Revit');
 assert.equal(sourceFormatLabel({schema:'DocumentSpatialModel'}),'Условная модель по документации');assert.equal(displayClass('DocumentElement'),'Элемент по документации');
});
test('diagnostics stay collapsed and preserve the exact original error on explicit expansion',t=>{
 const win=dom(t),host=document.createElement('div');document.body.append(host);const detail=addDiagnostics(host,raw);assert.equal(detail.open,false);assert.equal(host.querySelector('pre'),null);assert.doesNotMatch(surface(host),/TableCellStyle/);detail.open=true;detail.dispatchEvent(new win.Event('toggle'));assert.equal(host.querySelector('pre').textContent,raw);
});
test('property cards retain copyable engineering values and hide serialized fields safely',t=>{
 dom(t);const sets={'Оборудование':{'Мощность, кВт':7.5,'Производитель':'Тест','Параметр -123 [-123]':91,m_pointer:'internal'},'Источник RVT':{schema_sha256:'synthetic-hash'},RvtElementRecordGeometry:{BodySource:'saved_graphics_mesh',NominalDiameter:0.02,SourceStream:'Partitions/test'}};
 const before=JSON.stringify(sets),host=document.createElement('div');host.innerHTML=propertySections(sets);document.body.append(host);const shown=surface(host);assert.match(shown,/Мощность, кВт/);assert.match(shown,/7.5/);assert.doesNotMatch(shown,/m_pointer|internal|schema_sha256|synthetic-hash|Параметр -123/);assert(host.querySelector('button[data-copy="7.5"]'));assert.equal(JSON.stringify(sets),before);
 assert.match(shown,/Номинальный диаметр/);assert(host.querySelector('button[data-copy="0.02"]'));assert.doesNotMatch(shown,/saved_graphics_mesh|Partitions\/test|BodySource/);
 host.innerHTML=propertySections({'<img src=x>':{'<script>':'<b>unsafe</b>'}});assert.equal(host.querySelector('img,script,b'),null);
});

test('native category labels are readable while copied identifiers and source values stay exact',t=>{
 dom(t);const sets={Other:{Category:'Ducts','Type Id':'9007199254740993'},Constraints:{'Reference Level':'Этаж 01'},Pset_DuctSegmentTypeCommon:{Reference:'Тестовый тип'}};
 const before=JSON.stringify(sets),host=document.createElement('div');host.innerHTML=propertySections(sets);
 assert.match(surface(host),/Воздуховоды|Привязки|Опорный уровень|Свойства: Воздуховод/);
 assert.doesNotMatch(surface(host),/Constraints|Reference Level|Pset_Duct/);
 assert(host.querySelector('button[data-copy="Ducts"]'));assert(host.querySelector('button[data-copy="9007199254740993"]'));
 assert.equal(JSON.stringify(sets),before);
});

test('legacy panel uses the same error policy, escapes diagnostics and preserves a useful engineering message',t=>{
 dom(t);const host=document.createElement('div');document.body.append(host);
 globalThis.UvyazkaLanguage.showError(host,raw+' <img src=x onerror=alert(1)>');
 assert.doesNotMatch(surface(host),/TableCellStyle|100000|onerror/);assert.equal(host.querySelector('img'),null);
 assert.equal(host.querySelector('details').open,false);assert.match(host.querySelector('pre').textContent,/TableCellStyle/);
 globalThis.UvyazkaLanguage.showError(host,new Error('Укажите длину в миллиметрах.'));
 assert.equal(surface(host),'Укажите длину в миллиметрах.');assert.equal(host.querySelector('details'),null);
});

test('schedule filter captions keep native field IDs and operators out of normal text without changing the rule',async t=>{
 dom(t);const {scheduleControls}=await moduleAt('src/rvt-schedule-controls.ts');
 const host=document.createElement('div'),settings={grouping:'instances',filters:[{field_id:'7',operator:'not_equal',value:'Насос',value_type:'string'}],sum_fields:[]};
 const before=JSON.stringify(settings);scheduleControls(host,{all_columns:[{id:'7',properties:{m_columnHeading:'Наименование'}}],totals:[],selection:[],rule_audit:[]},settings,()=>{});
 const line=[...host.querySelectorAll('p')].find(p=>p.textContent.includes('Насос'));
 assert.match(line.textContent,/Наименование: не равно Насос/);assert.doesNotMatch(line.textContent,/not_equal|Поле 7/);assert.equal(JSON.stringify(settings),before);
});
test('unreadable schedule has a useful status and fallback, no raw graph or phantom zero-row table',async t=>{
 dom(t);document.body.innerHTML='<button id="reset-visibility"></button><button id="open-specifications"></button>';let created=0;document.getElementById('open-specifications').onclick=()=>created++;
 const {rvtDocumentPanel}=await moduleAt('src/rvt-document-panel.ts'),record={kind:'schedule',class_name:'DBViewSchedule',identity:{element_id:9001},status:'unsupported_graph',diagnostic:raw,graph:null},data={schema_version:1,schema_sha256:'a'.repeat(64),status:'partial',clipped_records:0,records:[record],summary:{},source:{filename:'synthetic.rvt',sha256:'b'.repeat(64),size_bytes:100},evaluated_schedule_body_available:false};
 const panel=rvtDocumentPanel(()=>{},()=>{},{model:()=>fixture().model});panel.openRecord(data,record,true);const dialog=document.getElementById('rvt-document'),shown=surface(dialog);assert.match(shown,/Спецификация · Revit 9001/);assert.match(shown,/Не удалось прочитать эту спецификацию/);assert.doesNotMatch(shown,/TableCellStyle|DBViewSchedule|100000|Граф этой записи|граф не прочитан/);assert.equal(dialog.querySelector('#rvt-preview'),null);assert.equal(dialog.querySelector('#rvt-record-detail table'),null);
 const diagnostics=dialog.querySelector('#rvt-record-detail > details');assert.equal(diagnostics.open,false);assert.match(diagnostics.textContent,/TableCellStyle/);[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Создать таблицу по элементам').click();assert.equal(created,1);assert.equal(dialog.open,false);
});
test('model data opens a readable card instead of a JSON dump while retaining source export',async t=>{
 dom(t);document.body.innerHTML='<button id="theme-toggle"></button>';const {model}=fixture();model.elements[0].property_sets={'Оборудование':{'Мощность, кВт':7.5,m_internal:90}};model.elements[0].revit={element_id:'9001',unique_id:'synthetic-native-id',phase_status:'unknown'};
 const {modelDataPanel}=await moduleAt('src/model-data-panel.ts');modelDataPanel(()=>model,()=>{});document.getElementById('open-model-data').click();document.querySelector('.model-data-table tbody button').click();const detail=document.querySelector('.model-data-detail');assert.match(surface(detail),/Revit ElementId/);assert.match(surface(detail),/Мощность, кВт/);assert.doesNotMatch(surface(detail),/m_internal|file_sha256|source_instance_id/);assert.equal(detail.querySelector('pre'),null);assert(detail.querySelector('button[data-copy="9001"]'));assert(detail.querySelector('.ui-diagnostics'));
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Standalone CAD application; the host exchanges files and status via postMessage.
import { AcApDocManager, acedApplyUiTheme } from '@mlightcad/cad-simple-viewer';
import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model';
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter';
import { FontManager } from '@mlightcad/mtext-renderer';
import { AcTrMTextRenderer } from '@mlightcad/three-renderer';
import './style.css';
const element=(id:string)=>document.getElementById(id)!;
const files={mtextRender:new URL('./assets/mtext-renderer-worker.js',location.href).href,dwgParser:new URL('./assets/libredwg-parser-worker.js',location.href).href};
AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG,new AcDbLibreDwgConverter({convertByEntityType:false,useWorker:true,parserWorkerUrl:files.dwgParser}));
acedApplyUiTheme('light',document.body);
AcApDocManager.createInstance({container:element('drawing'),autoResize:true,baseUrl:new URL('./',location.href).href,webworkerFileUrls:files,checkWorkersOnInit:true,useMainThreadDraw:false,disableExport:true});
const manager=AcApDocManager.instance;
FontManager.instance.defaultFonts=new Set(['NotoSans']);
void AcTrMTextRenderer.getInstance().setDefaultFonts(['NotoSans']);
const send=(data:object)=>parent.postMessage({channel:'uvyazka-cad',...data},location.origin);
let opening=false;
element('fit').onclick=()=>manager.curView.zoomToFitDrawing();
element('layers').onchange=()=>{
  const selected=(element('layers') as HTMLSelectElement).value;
  for(const layer of manager.curDocument.database.tables.layerTable.newIterator())layer.isOff=Boolean(selected&&layer.name!==selected);
  manager.curView.zoomToFitDrawing();
};
addEventListener('message',async event=>{
  if(event.origin!==location.origin||event.source!==parent||event.data?.channel!=='uvyazka-cad'||event.data.kind!=='open'||opening)return;
  const {file,job}=event.data;if(!(file instanceof File)||!/^.+\.(dwg|dxf)$/i.test(file.name)||file.size>64*1024*1024){send({kind:'error',job,message:'Нужен DWG / DXF до 64 MiB'});return;}
  opening=true; element('status').textContent='Чтение '+file.name;
  try{
    if(!await manager.areWorkersReady())throw Error('Не загружены локальные CAD worker / WASM');
    const content=await file.arrayBuffer();
    if(!await manager.openDocument(file.name,content,{mode:0,progressiveRendering:true}))throw Error('Движок не смог прочитать чертёж');
    await manager.curView.waitUntilIdle(30000);
    const db=manager.curDocument.database;
    const layers=[...db.tables.layerTable.newIterator()].map(l=>l.name);
    const selector=element('layers') as HTMLSelectElement;selector.replaceChildren(new Option('Все слои',''),...layers.map(l=>new Option(l,l)));
    element('status').textContent=`${file.name} · ${layers.length} слоёв · ${[...db.tables.blockTable.modelSpace.newIterator()].length} объектов · ${manager.curView.stats.summary.entityCount} отображено`;
    const count=[...db.tables.blockTable.modelSpace.newIterator()].length;
    if(!count)element('status').textContent+=' · В пространстве модели нет прочитанных объектов';
    send({kind:'opened',job,filename:file.name,layers,entityCount:count});
  }catch(error){element('status').textContent=String(error);send({kind:'error',job,message:String(error)});}
  finally{opening=false;}
});
send({kind:'ready'});

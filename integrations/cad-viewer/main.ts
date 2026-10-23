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
let activeJob:string|null=null,lastHighlight:string|null=null;
const hiddenObjects=new Set<string>();
const entityList=()=>[...manager.curDocument.database.tables.blockTable.modelSpace.newIterator()];
const layersList=()=>[...manager.curDocument.database.tables.layerTable.newIterator()];
function snapshot(){return {filename:element('status').dataset.filename??'',layers:layersList().map(l=>({name:l.name,visible:!l.isOff&&!l.isFrozen})),entities:entityList().map(e=>({id:String(e.objectId),type:e.dxfTypeName||e.type,layer:e.layer,visible:manager.curView.getEntityVisible(e.objectId)??null}))};}
function publishState(){send({kind:'tree-state',job:activeJob,...snapshot()});}
function applyHidden(){for(const entity of entityList())if(hiddenObjects.has(String(entity.objectId)))manager.curView.setEntitySceneVisible(entity.objectId,false);}
element('fit').onclick=()=>manager.curView.zoomToFitDrawing();
element('layers').onchange=()=>{
  const selected=(element('layers') as HTMLSelectElement).value;
  for(const layer of manager.curDocument.database.tables.layerTable.newIterator())layer.isOff=Boolean(selected&&layer.name!==selected);
  applyHidden();publishState();
  manager.curView.zoomToFitDrawing();
};
addEventListener('message',async event=>{
  if(event.origin!==location.origin||event.source!==parent||event.data?.channel!=='uvyazka-cad'||opening)return;
  const command=event.data;
  if(command.kind!=='open'){
    if(!activeJob||command.job!==activeJob)return;
    try{
      if(command.kind==='all-layer-visibility'){
        for(const layer of layersList()){layer.isOff=!command.visible;if(command.visible)layer.isFrozen=false;}applyHidden();
      }else if(command.kind==='layer-visibility'||command.kind==='isolate-layer'){
        const layer=layersList().find(l=>l.name===command.layer);if(!layer)throw Error('Слой не найден');
        for(const entry of layersList())if(command.kind==='isolate-layer'){entry.isOff=entry.name!==layer.name;if(entry.name===layer.name)entry.isFrozen=false;}else if(entry===layer){entry.isOff=!command.visible;if(command.visible)entry.isFrozen=false;}
        (element('layers') as HTMLSelectElement).value='';applyHidden();
      }else if(command.kind==='entity-visibility'){
        const entity=entityList().find(e=>String(e.objectId)===command.id);if(!entity)throw Error('Объект не найден');
        if(command.visible){hiddenObjects.delete(command.id);const layer=layersList().find(l=>l.name===entity.layer);if(layer){layer.isOff=false;layer.isFrozen=false;}}
        else hiddenObjects.add(command.id);
        if(!manager.curView.setEntitySceneVisible(entity.objectId,Boolean(command.visible)))throw Error('Объект не представлен в сцене');applyHidden();
      }else if(command.kind==='select-entity'){
        const entity=entityList().find(e=>String(e.objectId)===command.id);if(!entity)throw Error('Объект не найден');
        if(lastHighlight)manager.curView.unhighlight([lastHighlight]);manager.curView.highlight([entity.objectId]);lastHighlight=String(entity.objectId);
        send({kind:'entity-selected',job:activeJob,entity:{id:String(entity.objectId),type:entity.dxfTypeName||entity.type,layer:entity.layer}});
      }else if(command.kind==='reset-visibility'){
        for(const layer of layersList()){layer.isOff=false;layer.isFrozen=false;}hiddenObjects.clear();for(const entity of entityList())manager.curView.setEntitySceneVisible(entity.objectId,true);
        (element('layers') as HTMLSelectElement).value='';manager.curView.zoomToFitDrawing();
      }else return;
      await manager.curView.waitUntilIdle(5000);applyHidden();publishState();
    }catch(error){send({kind:'error',job:activeJob,message:String(error)});}return;
  }
  const {file,job}=event.data;if(!(file instanceof File)||!/^.+\.(dwg|dxf)$/i.test(file.name)||file.size>64*1024*1024){send({kind:'error',job,message:'Нужен DWG / DXF до 64 MiB'});return;}
  opening=true; element('status').textContent='Чтение '+file.name;
  activeJob=job;hiddenObjects.clear();lastHighlight=null;element('status').dataset.filename=file.name;
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
    send({kind:'opened',job,filename:file.name,layers,entityCount:count,tree:snapshot()});
  }catch(error){element('status').textContent=String(error);send({kind:'error',job,message:String(error)});}
  finally{opening=false;}
});
send({kind:'ready'});

import {exportSceneIfc} from './scene-ifc';
self.onmessage=async({data})=>{
 try{
  self.postMessage({progress:'Загрузка IFC-движка…'});
  const web=await import(/* @vite-ignore */data.base+'runtime/web-ifc/web-ifc-api.js');
  const api=new web.IfcAPI();api.SetWasmPath(data.base+'runtime/web-ifc/',true);await api.Init(undefined,true);
  const result=await exportSceneIfc(data.model,data.binary,web,api,{...data.options,progress:message=>self.postMessage({progress:message})});
  self.postMessage(result,{transfer:result.chunks.map(chunk=>chunk.buffer)});
 }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};

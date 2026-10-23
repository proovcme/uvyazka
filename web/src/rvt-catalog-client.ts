import type {RvtDocument} from './rvt-document';
export interface CatalogSummary {extraction_id:string;source:{filename?:string;sha256:string};record_count:number;profile:string;created_at:string}
async function response<T>(result:Response):Promise<T>{const data=await result.json();if(!result.ok)throw Error(data.error||'Не удалось прочитать базу RVT');return data;}
export async function loadProjectCatalog(project:string,hash:string):Promise<RvtDocument|null>{
 const q=new URLSearchParams({project_id:project,source_sha256:hash});const result=await response<{document:RvtDocument|null}>(await fetch('/api/rvt/catalog?'+q));return result.document;
}
export async function projectCatalogs(project:string,offset=0){return response<{items:CatalogSummary[];next_offset:number|null}>(await fetch('/api/rvt/catalog/list?'+new URLSearchParams({project_id:project,offset:String(offset),limit:'40'})));}
export async function loadModelCatalog(project:string,modelId:string){return response<{document:RvtDocument|null;source:{sha256:string;format:string}}>(await fetch('/api/rvt/catalog?'+new URLSearchParams({project_id:project,model_id:modelId})));}
export async function loadCatalogSnapshot(project:string,id:string){return (await response<{document:RvtDocument}>(await fetch('/api/rvt/catalog?'+new URLSearchParams({project_id:project,extraction_id:id})))).document;}
export async function saveProjectCatalog(project:string,document:RvtDocument):Promise<RvtDocument>{
 if(!project)throw Error('Сначала выберите проект');
 const config=await response<{write_token:string}>(await fetch('/api/rvt/catalog/config'));
 const result=await response<{extraction_id:string}>(await fetch('/api/rvt/catalog?'+new URLSearchParams({project_id:project}),{method:'POST',headers:{'Content-Type':'application/json','X-Uvyazka-Token':config.write_token},body:JSON.stringify({request_id:crypto.randomUUID(),document})}));
 const restored=await response<{document:RvtDocument}>(await fetch('/api/rvt/catalog?'+new URLSearchParams({project_id:project,extraction_id:result.extraction_id})));
 return restored.document;
}

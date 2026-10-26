import type {ModelPackage} from './model';

export type LinkKind='membership'|'port_owner'|'port_connection'|'element_connection'|'control'|'base_equipment';
export interface EngineeringLink {
 id:string;from:string;to:string;kind:LinkKind;
 source:{sha256:string;relation_id:string;relation_class:string;locator?:string};
}
export interface EngineeringNode {id:string;name:string;class:string;role:'element'|'port'|'system'|'unread';geometry:boolean}
export interface EngineeringGraph {nodes:Map<string,EngineeringNode>;links:EngineeringLink[];adjacency:Map<string,EngineeringLink[]>;issues:string[]}
export const linkLabel:Record<LinkKind,string>={membership:'В составе системы / цепи',port_owner:'Порт принадлежит элементу',port_connection:'Соединение портов',element_connection:'Соединение элементов',control:'Связь управления',base_equipment:'Базовое оборудование системы / цепи'};
const cache=new WeakMap<ModelPackage,EngineeringGraph>();

/** Only explicit file relations. Same names and group membership never create physical links. */
export function engineeringGraph(model:ModelPackage):EngineeringGraph{
 const old=cache.get(model);if(old)return old;
 const nodes=new Map<string,EngineeringNode>(),links:EngineeringLink[]=[],seen=new Set<string>(),issues:string[]=[];
 const elements=new Map(model.elements.map(e=>[e.id,e]));
 for(const e of model.elements)nodes.set(e.id,{id:e.id,name:e.name,class:e.class,role:(e.hierarchy??[]).includes('IfcPort')?'port':'element',geometry:!!e.mesh});
 for(const s of model.systems??[])nodes.set(s.id,{id:s.id,name:s.name||s.class,class:s.class,role:'system',geometry:false});
 const add=(from:string,to:string,kind:LinkKind,relation_id:string,relation_class:string,locator?:string)=>{
  if(!from||!to||from===to)return;
  const id=[kind,relation_id,from,to].join('|');if(seen.has(id))return;seen.add(id);
  const owner=elements.get(from)??elements.get(to);
  const source={sha256:owner?.source.file_sha256??model.source.sha256,relation_id,relation_class,...(locator?{locator}:{})};
  links.push({id,from,to,kind,source});
  for(const id of [from,to])if(!nodes.has(id))nodes.set(id,{id,name:'Не прочитано · '+id,class:'Unknown',role:'unread',geometry:false});
 };
 const assigned=new Set((model.engineering_links??[]).filter(l=>l.kind==='membership'&&l.source?.sha256&&l.source.relation_id&&l.source.relation_class).map(l=>l.from+'|'+l.to));
 for(const r of model.relationships??[]){
  const rid=(r.source_instance_id?r.source_instance_id+':':'')+r.step_id;
  for(const child of r.child_ids){
   if(r.class==='IfcRelAssignsToGroup'&&nodes.get(r.parent_id)?.role==='system'){add(r.parent_id,child,'membership',String(rid),r.class);assigned.add(r.parent_id+'|'+child);}
   if(r.class==='IfcRelConnectsPortToElement')add(r.parent_id,child,'port_owner',String(rid),r.class);
   if(r.class==='IfcRelNests'&&nodes.get(child)?.role==='port')add(r.parent_id,child,'port_owner',String(rid),r.class);
   if(r.class==='IfcRelConnectsPorts')add(r.parent_id,child,'port_connection',String(rid),r.class);
   if(r.class==='IfcRelConnectsElements'||r.class==='IfcRelConnectsPathElements')add(r.parent_id,child,'element_connection',String(rid),r.class);
   if(r.class==='IfcRelFlowControlElements')add(r.parent_id,child,'control',String(rid),r.class);
  }
 }
 for(const system of model.systems??[])for(const id of new Set(system.member_ids))if(!assigned.has(system.id+'|'+id))add(system.id,id,'membership',system.id,'ExtractedSystemMembership','systems.member_ids');
 for(const link of model.engineering_links??[]){
  if(!link.source?.sha256||!link.source.relation_class||!link.source.relation_id){issues.push('Пропущена связь без источника');continue;}
  if(!Object.hasOwn(linkLabel,link.kind)){issues.push('Неизвестный тип связи');continue;}
  const before=links.length;add(link.from,link.to,link.kind,link.source.relation_id,link.source.relation_class,link.source.locator);
  if(links.length>before)links[links.length-1].source={...link.source};
 }
 const adjacency=new Map<string,EngineeringLink[]>();
 for(const edge of links)for(const id of [edge.from,edge.to]){const rows=adjacency.get(id)??[];rows.push(edge);adjacency.set(id,rows);}
 issues.push(...(model.diagnostics??[]).filter(d=>d.kind==='native_mep').map(d=>d.message));
 const unread=[...nodes.values()].filter(n=>n.role==='unread').length;
 if(unread)issues.push(`${unread} участников связей не прочитаны`);
 if(!links.some(e=>e.kind==='port_connection'||e.kind==='element_connection'))issues.push('Физическая топология не прочитана. Членство в системе не доказывает подключение.');
 const graph={nodes,links,adjacency,issues};cache.set(model,graph);return graph;
}

export function engineeringNeighbours(graph:EngineeringGraph,id:string,kinds?:LinkKind[]){
 return (graph.adjacency.get(id)??[]).filter(link=>!kinds||kinds.includes(link.kind)).map(link=>({link,node:graph.nodes.get(link.from===id?link.to:link.from)!}));
}
export function engineeringPath(graph:EngineeringGraph,from:string,to:string,mode:'physical'|'membership'|'all'='physical',budget=20000){
 if(!graph.nodes.has(from)||!graph.nodes.has(to)||graph.nodes.get(from)?.role==='unread'||graph.nodes.get(to)?.role==='unread')return {status:'unknown_endpoint',nodes:[],links:[]} as const;
 if(from===to)return {status:'found',nodes:[from],links:[]} as const;
 const allowed:LinkKind[]=mode==='physical'?['port_owner','port_connection','element_connection']:mode==='membership'?['membership','base_equipment']:Object.keys(linkLabel)as LinkKind[];
 const queue=[from],previous=new Map<string,{id:string;link:EngineeringLink}>(),seen=new Set([from]);let cursor=0;
 while(cursor<queue.length){
  const id=queue[cursor++];
  if(cursor>budget)return {status:'budget_exceeded',nodes:[],links:[]} as const;
  for(const {node,link}of engineeringNeighbours(graph,id,allowed)){
   if(seen.has(node.id)||node.role==='unread')continue;seen.add(node.id);previous.set(node.id,{id,link});queue.push(node.id);
   if(node.id===to){const nodes=[to],links:EngineeringLink[]=[];let current=to;while(current!==from){const p=previous.get(current)!;links.unshift(p.link);nodes.unshift(p.id);current=p.id;}return {status:'found',nodes,links}as const;}
  }
 }
 return {status:'not_found_in_read_graph',nodes:[],links:[]}as const;
}

export function engineeringComponent(graph:EngineeringGraph,id:string,mode:'physical'|'membership',budget=20000){
 const allowed:LinkKind[]=mode==='physical'?['port_owner','port_connection','element_connection']:['membership','base_equipment'];
 if(!graph.nodes.has(id)||graph.nodes.get(id)?.role==='unread')return {ids:[],truncated:false};
 const found=new Set<string>(),queue=[id],queued=new Set([id]);let cursor=0;
 while(cursor<queue.length&&cursor<budget){const current=queue[cursor++];if(found.has(current))continue;found.add(current);for(const next of engineeringNeighbours(graph,current,allowed))if(next.node.role!=='unread'&&!queued.has(next.node.id)){queued.add(next.node.id);queue.push(next.node.id);}}
 return {ids:[...found],truncated:cursor<queue.length};
}

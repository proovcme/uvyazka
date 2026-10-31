/** Compact JSON value graph for immutable model metadata. Repeated values and
 * property names are stored once; geometry remains in separate binary files. */
type Wire=null|boolean|number|[0|1,number];
type Entry=['a',Wire[]]|['o',[number,Wire][]];
interface Envelope {contract:'UvyazkaSharedJson';version:1;root:Wire;nodes:Entry[];strings:string[]}
const MAX_NODES=1_500_000,MAX_DEPTH=256,MAX_WIRE=384*1024*1024;
export function encodeSharedJson(input:unknown):Envelope{
 const nodes:Entry[]=[],strings:string[]=[],seen=new WeakMap<object,number>(),active=new WeakSet<object>(),texts=new Map<string,number>(),intern=new Map<string,number>();let bytes=0;
 const text=(s:string)=>{let id=texts.get(s);if(id!==undefined)return id;if(strings.length>=MAX_NODES||s.length>MAX_WIRE)throw Error('Свойства модели превышают бюджет сохранения');bytes+=s.length*2;if(bytes>MAX_WIRE)throw Error('Свойства модели превышают бюджет сохранения');id=strings.length;texts.set(s,id);strings.push(s);return id;};
 const visit=(value:any,depth:number):Wire=>{
  if(depth>MAX_DEPTH)throw Error('Слишком глубокая структура свойств модели');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string')return [1,text(value)];
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='object'||ArrayBuffer.isView(value)||value instanceof ArrayBuffer)throw Error('Неподдержанное значение свойств модели');
  if(active.has(value))throw Error('Циклическая ссылка в свойствах модели');
  const old=seen.get(value);if(old!==undefined)return [0,old];active.add(value);
  const entry:Entry=Array.isArray(value)?['a',Array.from(value,(v:any)=>visit(v===undefined?null:v,depth+1))]:['o',Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[text(k),visit(v,depth+1)])];
  const signature=JSON.stringify(entry);let id=intern.get(signature);
  if(id===undefined){bytes+=signature.length;if(bytes>MAX_WIRE||nodes.length>=MAX_NODES)throw Error('Свойства модели превышают бюджет сохранения');id=nodes.length;nodes.push(entry);intern.set(signature,id);}
  active.delete(value);seen.set(value,id);return [0,id];
 };
 return {contract:'UvyazkaSharedJson',version:1,root:visit(input,0),nodes,strings};
}
export function decodeSharedJson(input:any):unknown{
 if(!input||input.contract!=='UvyazkaSharedJson'||input.version!==1||!Array.isArray(input.nodes)||input.nodes.length>MAX_NODES||!Array.isArray(input.strings)||input.strings.length>MAX_NODES||input.strings.some((s:unknown)=>typeof s!=='string'))throw Error('Неизвестное представление свойств модели');
 const nodes=input.nodes as Entry[],decoded:any[]=new Array(nodes.length),state=new Uint8Array(nodes.length);
 const text=(id:any)=>{if(!Number.isSafeInteger(id)||id<0||id>=input.strings.length)throw Error('Неверная ссылка на текст свойства');return input.strings[id] as string;};
 const visit=(value:any,depth:number):any=>{
  if(depth>MAX_DEPTH)throw Error('Слишком глубокая структура свойств модели');
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(!Array.isArray(value)||value.length!==2||![0,1].includes(value[0])||!Number.isSafeInteger(value[1]))throw Error('Неверная ссылка в свойствах модели');
  if(value[0]===1)return text(value[1]);
  const id=value[1];if(id<0||id>=nodes.length)throw Error('Неверная ссылка в свойствах модели');if(state[id]===1)throw Error('Циклическая ссылка в свойствах модели');if(state[id]===2)return decoded[id];
  const entry=nodes[id];if(!Array.isArray(entry)||entry.length!==2||!['a','o'].includes(entry[0])||!Array.isArray(entry[1]))throw Error('Повреждённая запись свойств модели');state[id]=1;
  if(entry[0]==='a')decoded[id]=entry[1].map(v=>visit(v,depth+1));
  else {const result:Record<string,unknown>={};decoded[id]=result;const keys=new Set<string>();for(const pair of entry[1]){
   if(!Array.isArray(pair)||pair.length!==2)throw Error('Неверный ключ свойства модели');const key=text(pair[0]);if(keys.has(key))throw Error('Повторный ключ свойства модели');keys.add(key);
   Object.defineProperty(result,key,{value:visit(pair[1],depth+1),enumerable:true,writable:true,configurable:true});
  }}state[id]=2;return decoded[id];
 };
 const result=visit(input.root,0);if(state.some(v=>v!==2))throw Error('В свойствах модели есть несвязанные записи');return result;
}

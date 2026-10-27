/** Form 1 of GOST 21.110-2013; layout is separate from source observations. */
export const gostColumns = [
 ['position','Поз.',20], ['name','Наименование и техническая характеристика',130],
 ['type','Тип, марка, обозначение документа, опросного листа',60], ['code','Код продукции',35],
 ['supplier','Поставщик',45], ['unit','Ед. измерения',20], ['quantity','Кол.',20],
 ['mass','Масса 1 ед., кг',25], ['note','Примечание',40],
] as const;
export type GostField = typeof gostColumns[number][0];
export const mappedFields = ['position','name','type','code','supplier','mass','note'] as const;
export type MappedField = typeof mappedFields[number];
export type GostBinding = {kind:'field';field_id:string;confirmed:boolean}|{kind:'constant';value:string;confirmed:boolean}|{kind:'blank';reason:string;confirmed:boolean}|{kind:'unmapped'};
export const drawingFields = ['designation','project','building','title','organization','developer','checker','normcontrol','approver','stage'] as const;
export interface GostSettings {
 version:1;template:'spds-equipment-1';bindings:Record<MappedField,GostBinding>;
 categories:string[];models:string[];system:string;levels:string[];
 unit:'шт.';quantity_confirmed:boolean;group_identical:boolean;
 drawing:Record<typeof drawingFields[number],string>;
}
export function emptyGostSettings():GostSettings{return {version:1,template:'spds-equipment-1',bindings:Object.fromEntries(mappedFields.map(k=>[k,{kind:'unmapped'}])) as GostSettings['bindings'],categories:[],models:[],system:'',levels:[],unit:'шт.',quantity_confirmed:false,group_identical:false,drawing:{designation:'',project:'',building:'',title:'Спецификация оборудования, изделий и материалов',organization:'',developer:'',checker:'',normcontrol:'',approver:'',stage:'Р'}};}
export function validateGostSettings(input:unknown):GostSettings {
 const x=input as GostSettings,keys=['version','template','bindings','categories','models','system','levels','unit','quantity_confirmed','group_identical','drawing'];
 if(!x||typeof x!=='object'||Object.keys(x).some(k=>!keys.includes(k))||Object.keys(x).length!==keys.length||x.version!==1||x.template!=='spds-equipment-1'||x.unit!=='шт.'||typeof x.quantity_confirmed!=='boolean'||typeof x.group_identical!=='boolean')throw Error('Неверный шаблон спецификации');
 for(const key of ['categories','models','levels'] as const)if(!Array.isArray(x[key])||x[key].length>1000||new Set(x[key]).size!==x[key].length||x[key].some(v=>typeof v!=='string'||!v||v.length>256))throw Error('Неверный состав спецификации');
 if(typeof x.system!=='string'||x.system.length>256)throw Error('Неверная система спецификации');
 if(!x.bindings||Object.keys(x.bindings).sort().join()!==[...mappedFields].sort().join())throw Error('Неверные привязки граф');
 for(const b of Object.values(x.bindings)){
  if(!b||typeof b!=='object')throw Error('Неверная привязка');
  const expected=b.kind==='field'?['kind','field_id','confirmed']:b.kind==='constant'?['kind','value','confirmed']:b.kind==='blank'?['kind','reason','confirmed']:b.kind==='unmapped'?['kind']:[];
  if(!expected.length||Object.keys(b).sort().join()!==expected.sort().join()||b.kind!=='unmapped'&&typeof b.confirmed!=='boolean')throw Error('Неверная привязка графы');
  if(b.kind==='field'&&(typeof b.field_id!=='string'||!b.field_id||b.field_id.length>2048)||b.kind==='constant'&&(typeof b.value!=='string'||b.value.length>2000)||b.kind==='blank'&&(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500))throw Error('Неверное значение привязки');
 }
 if(!x.drawing||Object.keys(x.drawing).sort().join()!==[...drawingFields].sort().join()||Object.values(x.drawing).some(v=>typeof v!=='string'||v.length>300))throw Error('Неверные реквизиты листа');
 return structuredClone(x);
}

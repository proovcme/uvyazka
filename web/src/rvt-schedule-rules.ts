import type {ValueCell} from './rvt-schedule.ts';

/** Explicit Uvyazka review rules, never an assumed mapping of native RVT enums. */
export type FilterOperator = 'equal'|'not_equal'|'greater'|'greater_equal'|'less'|'less_equal'|'contains'|'not_contains'|'begins'|'ends'|'has_value';
export interface ReviewFilter {
 field_id:string;
 operator:FilterOperator;
 value?:string|number;
 /** Numeric thresholds use the same raw unit as the field. */
 unit?:string;
}
export interface FilterDecision {
 state:'pass'|'fail'|'unknown';
 reason:string;
 filter:ReviewFilter;
 cell:ValueCell|null;
}
export function evaluateFilter(filter:ReviewFilter,cell:ValueCell|undefined):FilterDecision {
 const result=(state:FilterDecision['state'],reason:string):FilterDecision=>({state,reason,filter,cell:cell??null});
 if(!cell||cell.state!=='value')return result('unknown','Значение отсутствует, конфликтует или не поддержано; это не отрицательный результат фильтра.');
 if(filter.operator==='has_value')return result('pass','Прочитано типизированное значение (включая ноль и пустую строку).');
 const a=cell.value,b=filter.value;
 if(typeof a!==typeof b||!['string','number'].includes(typeof a))return result('unknown','Тип порога не совпадает с типом значения.');
 if(typeof a==='number'&&(!Number.isFinite(a)||!Number.isFinite(b)||cell.unit!==filter.unit))return result('unknown','Единицы порога не подтверждены или число не является конечным.');
 if(cell.storage_type==='ElementId'&&!['equal','not_equal'].includes(filter.operator))return result('unknown','Порядок ElementId не задаёт порядок уровней, фаз или типов.');
 let match:boolean;
 switch(filter.operator){
  case 'equal':match=a===b;break;
  case 'not_equal':match=a!==b;break;
  case 'greater':case 'greater_equal':case 'less':case 'less_equal':
   if(typeof a!=='number'||typeof b!=='number')return result('unknown','Сравнение порядка поддержано только для чисел.');
   match=filter.operator==='greater'?a>b:filter.operator==='greater_equal'?a>=b:filter.operator==='less'?a<b:a<=b;break;
  case 'contains':case 'not_contains':case 'begins':case 'ends':
   if(typeof a!=='string'||typeof b!=='string')return result('unknown','Текстовый фильтр требует строку.');
   match=filter.operator==='contains'?a.includes(b):filter.operator==='not_contains'?!a.includes(b):filter.operator==='begins'?a.startsWith(b):a.endsWith(b);break;
  default:return result('unknown','Оператор не поддержан.');
 }
 return result(match?'pass':'fail','Правило сверки Увязки: точное сравнение в исходных единицах; текст с учётом регистра.');
}

/** Unknown values sort last in both directions. IDs are deliberately not ordered. */
export function compareCells(a:ValueCell|undefined,b:ValueCell|undefined,direction:1|-1):number {
 const usable=(c:ValueCell|undefined)=>c?.state==='value'&&c.storage_type!=='ElementId';
 if(!usable(a)||!usable(b))return Number(usable(b))-Number(usable(a));
 if(a!.storage_type!==b!.storage_type||a!.unit!==b!.unit){const ka=JSON.stringify([a!.storage_type,a!.unit]),kb=JSON.stringify([b!.storage_type,b!.unit]);return ka<kb?-1:1;}
 if(typeof a!.value==='number'&&typeof b!.value==='number')return (a!.value-b!.value)*direction;
 if(typeof a!.value==='string'&&typeof b!.value==='string')return (a!.value<b!.value?-1:a!.value>b!.value?1:0)*direction;
 return 0;
}

export function sumCells(cells:ValueCell[]):ValueCell {
 const evidence=cells.flatMap(c=>c.evidence);
 if(!cells.length)return {state:'missing',reason:'Нет подтверждённых строк для суммы.',evidence};
 if(cells.some(c=>c.state!=='value'||typeof c.value!=='number'||!Number.isFinite(c.value)||!['Double','Integer'].includes(c.storage_type??'')))return {state:'unsupported',reason:'Сумма неполная: нужны числовые значения всех включённых экземпляров.',evidence};
 if(new Set(cells.map(c=>JSON.stringify([c.storage_type,c.unit]))).size!==1)return {state:'conflict',reason:'Типы или единицы слагаемых различаются.',evidence};
 // Compensated summation reduces floating-point error without rounding sources.
 let total=0,correction=0;
 for(const cell of cells){const y=(cell.value as number)-correction,t=total+y;correction=(t-total)-y;total=t;}
 if(!Number.isFinite(total)||(cells[0].storage_type==='Integer'&&!Number.isSafeInteger(total)))return {state:'unsupported',reason:'Переполнение суммы.',evidence};
 return {state:'value',value:total,storage_type:cells[0].storage_type,unit:cells[0].unit,evidence};
}

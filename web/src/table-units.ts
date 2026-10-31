import type {ValueCell} from './rvt-schedule.ts';
// Explicit scalar conversions only. Native RVT numbers with unresolved units
// are never assigned a dimension from their caption or a nonzero value.
const units:Record<string,[string,number]>={mm:['length',.001],cm:['length',.01],m:['length',1],ft:['length',.3048],in:['length',.0254],
 m2:['area',1],ft2:['area',.09290304],mm2:['area',.000001],m3:['volume',1],ft3:['volume',.028316846592],L:['volume',.001],
 kg:['mass',1],g:['mass',.001],t:['mass',1000],W:['power',1],kW:['power',1000],MW:['power',1000000],
 VA:['apparent_power',1],kVA:['apparent_power',1000],Pa:['pressure',1],kPa:['pressure',1000],MPa:['pressure',1000000],
 'm3/s':['flow',1],'m3/h':['flow',1/3600],'L/s':['flow',.001],'L/min':['flow',.001/60],
 s:['time',1],min:['time',60],h:['time',3600],A:['current',1],mA:['current',.001],Ah:['charge',3600],mAh:['charge',3.6],
 V:['voltage',1],kV:['voltage',1000],Hz:['frequency',1],kHz:['frequency',1000]};
export const tableOutputUnits=Object.keys(units);
export function compatibleTableUnits(unit:string){return units[unit]?tableOutputUnits.filter(u=>units[u][0]===units[unit][0]):[];}
export function convertTableCell(cell:ValueCell,target?:string):ValueCell{
 if(!target||cell.state!=='value')return cell;
 const source=cell.unit&&units[cell.unit],destination=units[target];
 if(typeof cell.value!=='number'||cell.storage_type==='ElementId'||!source||!destination||source[0]!==destination[0])return {...cell,state:'unsupported',reason:'Пересчёт недоступен: исходная единица или размерность не подтверждена'};
 const value=cell.value*source[1]/destination[1];if(!Number.isFinite(value))return {...cell,state:'unsupported',reason:'Переполнение при переводе единиц'};
 return {...cell,value,storage_type:'Double',unit:target,evidence:[...cell.evidence,{owner_id:'@unit_conversion',path:['unit_conversion'],value:{source_value:cell.value,source_unit:cell.unit,target_unit:target,multiplier:source[1]/destination[1]},storage_type:'conversion',location:{rule:'uvyazka_explicit_scalar_units_v1'}}]};
}

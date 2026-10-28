import type {ModelPackage} from './model';
export const isNavisFormat=(format:string|undefined)=>format==='nwd'||format==='nwc';
export const onlyNavisSources=(model:ModelPackage)=>isNavisFormat(model.source.format)||!!(model.federation?.members.length&&model.federation.members.every(member=>isNavisFormat(member.source_format)));

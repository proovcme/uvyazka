/** Opt-in local diagnostics. No source names, properties or network telemetry. */
export const performanceDiagnostics=typeof location!=='undefined'&&new URLSearchParams(location.search).get('diagnostics')==='performance';
export const individualRendering=performanceDiagnostics&&new URLSearchParams(location.search).get('rendering')==='individual';
const samples=new Map<string,number>();
export function performanceSample(operation:string,start:number,details:Record<string,number|boolean|string>={}){
 if(!performanceDiagnostics)return;
 const count=samples.get(operation)??0;if(count>=20)return;samples.set(operation,count+1);
 console.info('uvyazka-performance '+JSON.stringify({operation,ms:Math.round((performance.now()-start)*100)/100,...details}));
}

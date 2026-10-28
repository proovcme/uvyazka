import {federate} from './federation';
self.onmessage=async({data})=>{try{const result=await federate(data.members,text=>self.postMessage({kind:'progress',text}));self.postMessage({kind:'ready',...result},{transfer:[result.binary]});}catch(error){self.postMessage({kind:'error',message:error instanceof Error?error.message:String(error)});}};

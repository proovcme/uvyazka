import {compareRevisions} from './revision-diff';
import {revisionIdMap} from './source-revision';
self.onmessage=({data})=>{try{const report=compareRevisions(data.before,data.after,true),mapping=[...revisionIdMap(data.before,data.after)];self.postMessage({report,mapping});}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};

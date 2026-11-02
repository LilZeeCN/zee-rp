import { runStudioOperation,watchOperationCancellation } from './operations.mjs';
const [directory,id,mode]=process.argv.slice(2);
try{if(mode==='cancel-watch')await watchOperationCancellation(directory,id);else await runStudioOperation(directory,id);}
catch(error){process.stderr.write(JSON.stringify({code:error.code||'E_OPERATION_WORKER',message:error.message})+'\n');process.exitCode=1;}

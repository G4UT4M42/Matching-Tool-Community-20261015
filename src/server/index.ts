import {createCommunityApplication} from './application.js';
// Sanitize unexpected asynchronous failures; never log a provider payload.
process.on('unhandledRejection',()=>{console.error('[server] Fatal asynchronous operation failure');process.exit(1);});
process.on('uncaughtException',()=>{console.error('[server] Fatal application operation failure');process.exit(1);});
const application=createCommunityApplication();
const server=application.app.listen(application.port,application.host,()=>{
  console.log(`[server] Local application listening on port ${application.port}`);
  console.log(`[server] Authentication mode: ${application.authMode}; release acceptance remains pending`);
});
let stopping=false;
function stop(){if(stopping)return;stopping=true;server.close(()=>{void application.close().then(()=>process.exit(0),()=>process.exit(1));});}
process.once('SIGTERM',stop);process.once('SIGINT',stop);

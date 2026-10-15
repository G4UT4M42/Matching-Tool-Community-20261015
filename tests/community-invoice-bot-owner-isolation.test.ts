import { expect, it } from 'vitest';
import { InvoiceBotCoordinator, type BrowserSessionCallbacks, type PortalAdapter } from '../src/community/invoice-bot/coordinator.js';
import type { CommunityDocumentService } from '../src/community/documents/service.js';

it('isolates discovered invoices and cancellation by owner subject within one shared workspace',async()=>{
 const owner={subject:'USR-synthetic-owner-a',workspace_id:'WS-synthetic'};
 const other={subject:'USR-synthetic-owner-b',workspace_id:'WS-synthetic'};
 const sessions:BrowserSessionCallbacks={openFreshSession:async()=>{},disconnect:async()=>{},isConnected:async()=>true};
 const adapter:PortalAdapter={id:'synthetic-fixture',label:'Synthetic provider only',origin:'http://127.0.0.1:55555',
   connect:async()=>{},discover:async()=>[{source_id:'SYN-A',filename:'synthetic.pdf',href:'/invoice/SYN-A'}],
   download:async()=>Buffer.from('Synthetic only')};
 const bot=new InvoiceBotCoordinator([adapter],sessions,{} as CommunityDocumentService,true);
 const run=await bot.discover(owner,adapter.id);
 expect(run.status).toBe('discovered');
 expect(bot.listRuns(owner)).toHaveLength(1);
 expect(bot.listRuns(other)).toEqual([]);
 expect(()=>bot.getRun(other,run.id)).toThrow('Run not found');
 expect(()=>bot.cancel(other,run.id)).toThrow('Run not found');
 expect(bot.getRun(owner,run.id).status).toBe('discovered');
});

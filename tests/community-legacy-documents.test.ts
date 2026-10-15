import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {CommunityDocumentService} from '../src/community/documents/service.js';
import type {MatchingState} from '../src/core/types.js';
let root:string,state:MatchingState,db:typeof import('../src/storage/db.js'),json:typeof import('../src/storage/json-store.js'),canonical:typeof import('../src/storage/canonical-transaction.js');
const owner={subject:'SYNTHETIC-MIGRATION-OWNER',workspace_id:'SYNTHETIC-MIGRATION-WORKSPACE'},bytes=Buffer.from('SYNTHETIC HISTORICAL ORIGINAL');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const originalRoot=process.env.MATCHING_RUNTIME_ROOT,originalMode=process.env.MATCHING_RUNTIME_MODE;
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),'community-legacy-document-'));process.env.MATCHING_RUNTIME_ROOT=root;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();db=await import('../src/storage/db.js');db.getDb();json=await import('../src/storage/json-store.js');canonical=await import('../src/storage/canonical-transaction.js');state=json.createEmptyState('SYNTHETIC-LEGACY-DOCUMENTS');mkdirSync(join(root,'documents'));writeFileSync(join(root,'documents','SYNTHETIC-HISTORICAL-BLOB'),bytes);state.documents.set('SYNTHETIC-DOC',{document_id:'SYNTHETIC-DOC',source_system:'upload',source_document_ref:'SYNTHETIC-ORIGINAL-REF',captured_at:'2025-06-15T12:00:00.000Z',document_date:'2025-06-15',total_amount_minor:1234,currency_code:'EUR',supplier_name:'Fictional historical supplier',filename:'SYNTHETIC-HISTORICAL-BLOB',file_hash:sha(bytes),meta:{synthetic:true}});json.saveState(state);canonical.initializeCanonicalState(state);});
afterEach(()=>{db.closeDb();if(originalRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=originalRoot;if(originalMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=originalMode;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});vi.resetModules();});
function service(workspaceId?:string){return new CommunityDocumentService({root:join(root,'documents'),workspaceId,getState:()=>state,persistAndActivate:(before,next,actor)=>{state=canonical.commitCanonicalState(before,next,actor);}});}
describe('normal retrieval of supported migrated historical originals',()=>{
 it('binds unscoped legacy evidence to the configured workspace without inventing original ownership or changing financial source fields',async()=>{
  const original=json.serializeCommunityState(state);expect(await service().list(owner)).toEqual([]);
  const docs=service(owner.workspace_id),records=await docs.list(owner);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({id:'SYNTHETIC-DOC',owner_subject:'',workspace_id:owner.workspace_id,mime:'application/octet-stream',hash:sha(bytes)});expect((await docs.download(owner,'SYNTHETIC-DOC')).buffer.equals(bytes)).toBe(true);expect(json.serializeCommunityState(state)).toBe(original);expect(readFileSync(join(root,'documents','SYNTHETIC-HISTORICAL-BLOB')).equals(bytes)).toBe(true);
  expect(await docs.list({...owner,workspace_id:'SYNTHETIC-OTHER-WORKSPACE'})).toEqual([]);await expect(docs.download({...owner,workspace_id:'SYNTHETIC-OTHER-WORKSPACE'},'SYNTHETIC-DOC')).rejects.toMatchObject({code:'NOT_FOUND'});
  await docs.disposition(owner,'SYNTHETIC-DOC','archive');await docs.disposition(owner,'SYNTHETIC-DOC','restore');db.closeDb();db.getDb();state=json.loadState()!;canonical.initializeCanonicalState(state);expect((await service(owner.workspace_id).download(owner,'SYNTHETIC-DOC')).buffer.equals(bytes)).toBe(true);expect(state.documents.get('SYNTHETIC-DOC')?.source_document_ref).toBe('SYNTHETIC-ORIGINAL-REF');
 });
});

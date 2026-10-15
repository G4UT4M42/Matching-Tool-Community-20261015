import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeHistoricalPaymentEvidence } from '../src/community/persistence/backup.js';
// @ts-expect-error Synthetic reusable JavaScript fixture has no declaration file.
import { createCompleteLegacyFixture } from './helpers/complete-legacy-fixture.mjs';
const previousRoot=process.env.MATCHING_RUNTIME_ROOT,previousMode=process.env.MATCHING_RUNTIME_MODE;
let base:string|undefined,close:(()=>void)|undefined;
afterEach(()=>{close?.();close=undefined;if(base)rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});base=undefined;if(previousRoot===undefined)delete process.env.MATCHING_RUNTIME_ROOT;else process.env.MATCHING_RUNTIME_ROOT=previousRoot;if(previousMode===undefined)delete process.env.MATCHING_RUNTIME_MODE;else process.env.MATCHING_RUNTIME_MODE=previousMode;vi.resetModules();});
describe('bounded historical payment evidence backup projection',()=>{
  it('preserves reviewed economic/legal history and recursively removes reusable authority',()=>{
    const source={status:'released',approval_status:'approved',approved_at:'2025-06-15T12:00:00Z',approved_by:'SYNTHETIC-REVIEWER',amount_minor:5000,authorization:'SYNTHETIC-AUTHORITY',approval_token:'SYNTHETIC-CAPABILITY',account:{iban:'DE36'+'0'.repeat(18),label:'Fictional account',cookie:'SYNTHETIC-COOKIE'},items:[{document_id:'SYN-D1',amount_minor:5000,access_token:'SYNTHETIC-TOKEN'}]};
    expect(JSON.parse(sanitizeHistoricalPaymentEvidence(JSON.stringify(source))!)).toEqual({status:'released',approval_status:'approved',approved_at:'2025-06-15T12:00:00Z',approved_by:'SYNTHETIC-REVIEWER',amount_minor:5000,account:{iban:'DE36'+'0'.repeat(18),label:'Fictional account'},items:[{document_id:'SYN-D1',amount_minor:5000}]});
  });
  it('retains supported payment batch snapshot fields while removing exported transfer artifacts',()=>{
    const source={batch_id:'SYN-BATCH',debtor_account_label:'Fictional account',debtor_account_holder:'Fictional holder',george_package_reference:'SYN-PACKAGE',classification:'paid',export_artifact_path:'SYNTHETIC-EXPORT.xml',export_artifact_data:'SYNTHETIC-TRANSFER-ARTIFACT'};
    expect(JSON.parse(sanitizeHistoricalPaymentEvidence(JSON.stringify(source))!)).toEqual({batch_id:'SYN-BATCH',debtor_account_label:'Fictional account',debtor_account_holder:'Fictional holder',george_package_reference:'SYN-PACKAGE',classification:'paid'});
  });
  for(const[index,value]of [{provider_payload:'unreviewed'},{reference:'Bearer SYNTHETIC'},{status:'x'.repeat(301)},{amount_minor:1.5},{status:'unsafe\ncontrol'},{constructor:{status:'released'}}].entries())it('rejects unreviewed provider text, shapes, numeric values and unsafe keys '+index,()=>{expect(()=>sanitizeHistoricalPaymentEvidence(JSON.stringify(value))).toThrow(/Unreviewed/);});
  it('retains exact safe event evidence in a real backup while excluding synthetic authority and leaving the live audit unchanged',async()=>{
    base=mkdtempSync(join(tmpdir(),'community-payment-history-synthetic-'));const active=join(base,'active'),source=join(base,'source');createCompleteLegacyFixture(source);
    process.env.MATCHING_RUNTIME_ROOT=active;process.env.MATCHING_RUNTIME_MODE='external-runtime-root';vi.resetModules();
    const store=await import('../src/storage/db.js');close=store.closeDb;store.getDb();const json=await import('../src/storage/json-store.js'),canonical=await import('../src/storage/canonical-transaction.js'),migration=await import('../src/community/persistence/legacy.js'),restore=await import('../src/community/persistence/restore.js'),backup=await import('../src/community/persistence/backup.js');
    const state=json.createEmptyState('SYNTHETIC-PRIOR');json.saveState(state);canonical.initializeCanonicalState(state);const preview=await migration.inspectLegacy(source),stage=await migration.stageLegacyConversion(active,source,preview.fingerprint,async run=>run());
    await restore.activateCommunityRestore(active,stage.id,stage.fingerprint,async run=>run(),async change=>{store.closeDb();change();store.getDb();canonical.initializeCanonicalState(json.loadState()!);});
    const db=store.getDb(),event={status:'released',amount_minor:5000,approval_token:'SYNTHETIC-REUSABLE-AUTHORITY',account:{label:'Fictional account',access_token:'SYNTHETIC-ACCESS'}};
    db.prepare('INSERT INTO payment_status_events(event_id,batch_id,actor,occurred_at,new_status,after_json) VALUES(?,?,?,?,?,?)').run('SYN-SECOND-EVENT','SYN-PAYMENT-HISTORY','SYNTHETIC-OWNER','2025-06-16T12:00:00Z','released',JSON.stringify(event));
    const artifact=await backup.createCommunityBackup(active,async run=>run()),files=backup.inspectBackupBytes(readFileSync(artifact.path)).files,path=join(base,'backup-inspection.db');writeFileSync(path,files.get('database/matching.db')!);
    const archived=new Database(path,{readonly:true});try{
      const original=db.prepare("SELECT george_evidence_json,before_json,after_json FROM payment_status_events WHERE event_id='SYN-PAYMENT-EVENT'").get();
      expect(archived.prepare("SELECT george_evidence_json,before_json,after_json FROM payment_status_events WHERE event_id='SYN-PAYMENT-EVENT'").get()).toEqual(original);
      const sealed=archived.prepare("SELECT after_json FROM payment_status_events WHERE event_id='SYN-SECOND-EVENT'").pluck().get() as string;expect(JSON.parse(sealed)).toEqual({status:'released',amount_minor:5000,account:{label:'Fictional account'}});
      expect(readFileSync(path).includes(Buffer.from('SYNTHETIC-REUSABLE-AUTHORITY'))).toBe(false);expect(readFileSync(path).includes(Buffer.from('SYNTHETIC-ACCESS'))).toBe(false);
    }finally{archived.close();}
    expect(JSON.parse(db.prepare("SELECT after_json FROM payment_status_events WHERE event_id='SYN-SECOND-EVENT'").pluck().get() as string)).toEqual(event);
  });
});

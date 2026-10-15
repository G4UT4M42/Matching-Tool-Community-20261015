import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { communitySchemaDigest, initializeCommunitySqliteV1, verifyCommunitySqliteV1 } from '../src/migrations/001-community-sqlite-baseline.js';
import { upgradeCommunitySqliteV1ToV2, verifyCommunitySqliteV2 } from '../src/migrations/002-statement-journal-capability.js';
import { COMMUNITY_SCHEMA_VERSION, upgradeCommunitySchema, verifyCommunitySchema } from '../src/migrations/community-registry.js';
import { runMigrations } from '../src/storage/db.js';
const names=['schema.sql','schema-invoicerec.sql','schema-invoicebot.sql','schema-costmonitor.sql','schema-payments.sql'];
const sources=names.map(name=>readFileSync(join(import.meta.dirname,'..','src','storage',name),'utf8'));
const digest=communitySchemaDigest(sources);
function fixture(version=2){
  const db=new Database(':memory:');initializeCommunitySqliteV1(db,sources,()=>runMigrations(db));
  db.prepare("INSERT INTO transactions(transaction_id,source_system,source_account_id,source_row_ref,posting_at,amount_minor,currency_code,description_raw) VALUES('SYN-T','sparkasse','SYN-A','SYN-ROW','2026-01-12',-1234,'EUR','Synthetic migration data')").run();
  if(version===2)upgradeCommunitySqliteV1ToV2(db,digest);return db;
}

describe('immutable canonical/payment migration registry',()=>{
  it.each([1,2])('upgrades version %s through every declared edge without rewriting earlier ledgers or source rows',version=>{
    const db=fixture(version);try{
      const before=db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all();
      const tx=db.prepare('SELECT * FROM transactions').all();upgradeCommunitySchema(db,digest);
      expect(db.pragma('user_version',{simple:true})).toBe(COMMUNITY_SCHEMA_VERSION);verifyCommunitySchema(db,digest);
      expect(db.prepare('SELECT * FROM community_storage_migrations WHERE to_version<=? ORDER BY to_version').all(version)).toEqual(before);
      expect(db.prepare('SELECT * FROM transactions').all()).toEqual(tx);
      expect(db.prepare('SELECT capability FROM community_storage_capabilities ORDER BY capability').pluck().all()).toEqual(['canonical-state-journal-v1','payment-management-v1','statement-journal-v1']);
      const all=db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all();upgradeCommunitySchema(db,digest);
      expect(db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all()).toEqual(all);
      expect(()=>verifyCommunitySqliteV1(db,digest)).toThrow(/Unsupported/);expect(()=>verifyCommunitySqliteV2(db,digest)).toThrow(/Unsupported/);
    }finally{db.close();}
  });
  it.each([3,4])('rolls back all new edges when interruption occurs at version %s',at=>{
    const db=fixture();try{
      const original=db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all();
      expect(()=>upgradeCommunitySchema(db,digest,version=>{if(version===at)throw new Error('SYNTHETIC_UPGRADE_INTERRUPTION');})).toThrow('SYNTHETIC_UPGRADE_INTERRUPTION');
      verifyCommunitySqliteV2(db,digest);expect(db.pragma('user_version',{simple:true})).toBe(2);
      expect(db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all()).toEqual(original);
      expect(db.prepare("SELECT count(*) FROM sqlite_schema WHERE name IN ('community_canonical_state','community_payment_batches')").pluck().get()).toBe(0);
    }finally{db.close();}
  });
  it('enforces append-only audit and migration provenance at the SQL boundary',()=>{
    const db=fixture();try{
      upgradeCommunitySchema(db,digest);db.prepare("INSERT INTO audit_events(audit_id,timestamp,actor_type,actor_id,action,entity_type,entity_id) VALUES('SYN-AUD','2026-01-12','user','synthetic-owner','STATE_COMMITTED','Run','SYN')").run();
      expect(()=>db.prepare('DELETE FROM audit_events').run()).toThrow(/append only/);
      expect(()=>db.prepare("UPDATE audit_events SET actor_id='forged'").run()).toThrow(/append only/);
      expect(()=>db.prepare("UPDATE community_storage_migrations SET checksum_sha256='forged'").run()).toThrow(/immutable/);
      expect(()=>db.prepare('DELETE FROM community_storage_migrations').run()).toThrow(/immutable/);
      verifyCommunitySchema(db,digest);
    }finally{db.close();}
  });
  it('rejects unsupported future versions and physical schema changes rather than repairing a ledger',()=>{
    const db=fixture();try{
      upgradeCommunitySchema(db,digest);const before=db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all();
      db.exec('CREATE TABLE synthetic_unregistered_extension(id TEXT)');expect(()=>verifyCommunitySchema(db,digest)).toThrow(/physical schema/);
      expect(()=>upgradeCommunitySchema(db,digest)).toThrow();
      expect(db.prepare('SELECT * FROM community_storage_migrations ORDER BY to_version').all()).toEqual(before);
      db.pragma('user_version=999');expect(()=>upgradeCommunitySchema(db,digest)).toThrow(/Unsupported/);
    }finally{db.close();}
  });
});

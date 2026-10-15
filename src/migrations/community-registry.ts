import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMUNITY_SQLITE_MIGRATION_ID, communityPhysicalSchemaDigest, verifyCommunitySqliteV1 } from './001-community-sqlite-baseline.js';
import { COMMUNITY_SQLITE_V2_ID, COMMUNITY_SQLITE_V2_CHECKSUM, STATEMENT_JOURNAL_CAPABILITY, verifyCommunitySqliteV2, upgradeCommunitySqliteV1ToV2 } from './002-statement-journal-capability.js';
import { upCommunityPayments003 } from './003-community-payments.js';
import { CANONICAL_STATE_CAPABILITY, CANONICAL_STATE_MIGRATION_CHECKSUM, upCommunityCanonicalState004 } from './004-community-canonical-state.js';

export const COMMUNITY_SCHEMA_VERSION = 4;
export const PAYMENT_SCHEMA_CAPABILITY = 'payment-management-v1';
export const PAYMENT_MIGRATION_ID = 'community-sqlite-v3-payments';
export const CANONICAL_MIGRATION_ID = 'community-sqlite-v4-canonical-state';
// The formerly isolated payment migration becomes a registered immutable edge.
// Normalize checkout newlines only; executable migration source bytes determine its digest.
export const PAYMENT_MIGRATION_CHECKSUM = createHash('sha256').update('registered-community-payment-migration-v3\n')
  .update(readFileSync(fileURLToPath(new URL('./003-community-payments.ts', import.meta.url)), 'utf8').replace(/\r\n/g,'\n')).digest('hex');
interface LedgerRow { migration_id:string;from_version:number;to_version:number;checksum_sha256:string;schema_sha256:string }
const specs=(baseline:string)=>[
  {id:COMMUNITY_SQLITE_MIGRATION_ID,from:0,to:1,checksum:baseline},
  {id:COMMUNITY_SQLITE_V2_ID,from:1,to:2,checksum:COMMUNITY_SQLITE_V2_CHECKSUM},
  {id:PAYMENT_MIGRATION_ID,from:2,to:3,checksum:PAYMENT_MIGRATION_CHECKSUM},
  {id:CANONICAL_MIGRATION_ID,from:3,to:4,checksum:CANONICAL_STATE_MIGRATION_CHECKSUM},
];

/** Verify both historical ledger identity and the exact current physical schema. */
export function verifyCommunitySchema(db: Database.Database, baselineDigest: string, expectedVersion=COMMUNITY_SCHEMA_VERSION): void {
  const version=Number(db.pragma('user_version',{simple:true}));
  if(version!==expectedVersion||version<1||version>COMMUNITY_SCHEMA_VERSION)throw new Error('Unsupported Community SQLite schema version');
  if(version===1){verifyCommunitySqliteV1(db,baselineDigest);return;}
  if(version===2){verifyCommunitySqliteV2(db,baselineDigest);return;}
  const rows=db.prepare('SELECT migration_id,from_version,to_version,checksum_sha256,schema_sha256 FROM community_storage_migrations ORDER BY to_version').all() as LedgerRow[];
  const expected=specs(baselineDigest).slice(0,version);
  if(rows.length!==expected.length||rows.some((row,index)=>row.migration_id!==expected[index].id||row.from_version!==expected[index].from||row.to_version!==expected[index].to||row.checksum_sha256!==expected[index].checksum||!/^([a-f0-9]{64})$/.test(row.schema_sha256))||rows.at(-1)!.schema_sha256!==communityPhysicalSchemaDigest(db)){
    throw new Error('Community SQLite migration checksum, physical schema or history mismatch');
  }
  const capabilities=db.prepare('SELECT capability,capability_version FROM community_storage_capabilities ORDER BY capability').all() as Array<{capability:string;capability_version:number}>;
  const wanted=[STATEMENT_JOURNAL_CAPABILITY,PAYMENT_SCHEMA_CAPABILITY,...(version>=4?[CANONICAL_STATE_CAPABILITY]:[])].sort();
  if(capabilities.length!==wanted.length||capabilities.some((row,index)=>row.capability!==wanted[index]||row.capability_version!==1))throw new Error('Unsupported Community SQLite capability registry');
}

/** Upgrade additive edges as one atomic transaction. No prior ledger is rewritten. */
export function upgradeCommunitySchema(db:Database.Database,baselineDigest:string,hook?:(version:number)=>void):void{
  const initial=Number(db.pragma('user_version',{simple:true}));
  if(initial<1||initial>COMMUNITY_SCHEMA_VERSION)throw new Error('Unsupported Community SQLite upgrade source version');
  verifyCommunitySchema(db,baselineDigest,initial);
  if(initial===COMMUNITY_SCHEMA_VERSION)return;
  db.transaction(()=>{
    let version=initial;
    if(version===1){upgradeCommunitySqliteV1ToV2(db,baselineDigest);version=2;hook?.(2);}
    for(const to of [3,4]){
      if(version>=to)continue;
      if(version!==to-1)throw new Error('Missing registered schema edge');
      verifyCommunitySchema(db,baselineDigest,version);
      const spec=specs(baselineDigest)[to-1];
      if(to===3)upCommunityPayments003(db);else upCommunityCanonicalState004(db);
      const capability=to===3?PAYMENT_SCHEMA_CAPABILITY:CANONICAL_STATE_CAPABILITY;
      db.prepare('INSERT INTO community_storage_capabilities(capability,capability_version) VALUES (?,1)').run(capability);
      db.prepare('INSERT INTO community_storage_migrations(migration_id,from_version,to_version,checksum_sha256,schema_sha256,applied_at) VALUES (?,?,?,?,?,?)')
        .run(spec.id,spec.from,spec.to,spec.checksum,communityPhysicalSchemaDigest(db),new Date().toISOString());
      db.pragma('user_version = '+to);version=to;hook?.(to);
      verifyCommunitySchema(db,baselineDigest,to);
    }
  }).immediate();
  verifyCommunitySchema(db,baselineDigest);
}

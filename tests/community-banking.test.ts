import { describe,it,expect } from 'vitest';
import Database from 'better-sqlite3';
import { upCommunityPayments003 } from '../src/migrations/003-community-payments.js';
import { CommunityBankingService } from '../src/community/banking/service.js';
import { localFakeAdapters,LOCAL_FAKE_BANK_MARKER } from '../src/community/banking/mock.js';
import { EnableBankingAisAdapter } from '../src/community/banking/enablebanking-ais.js';
import { generateKeyPairSync } from 'node:crypto';
import type { Principal } from '../src/community/payments/types.js';

const owner:Principal={subject:'fictional-owner',workspace_id:'ws',session_id:'s',role:'owner',authenticated_at:'2026-10-14T06:00:00Z',permissions:['integrations:read','integrations:configure','integrations:sync']};
describe('user scoped read-only bank contract',()=>{
  it('stores only a vault reference, never advertises initiation, and scopes sync',async()=>{
    const db=new Database(':memory:');upCommunityPayments003(db);const fake=localFakeAdapters(LOCAL_FAKE_BANK_MARKER);let stored=0, imported=0;
    const service=new CommunityBankingService(db,(p,permission)=>p.permissions.includes(permission),{resolve:async input=>{expect(input.subject).toBe(owner.subject);return {synthetic:true}}},fake.read,{storeCredential:async()=>{stored++;return 'vault:synthetic'},importTransactions:async({transactions})=>{imported++;return {imported:transactions.length,skipped:0}}});
    expect(service.capabilities()[0].paymentInitiation).toBe(false);expect(service.status(owner).configured).toBe(false);
    await service.configure(owner,'fictional-account',{secret:'LOCAL-ONLY'});expect(stored).toBe(1);expect(service.status(owner).configured).toBe(true);
    const row=db.prepare('SELECT * FROM community_bank_connections').get() as Record<string,unknown>;expect(JSON.stringify(row)).not.toContain('LOCAL-ONLY');
    expect(service.status({...owner,subject:'another'}).configured).toBe(false);
    expect(await service.accounts(owner)).toEqual([]);expect(await service.sync(owner,'2026-10-01','2026-10-14')).toEqual({imported:0,skipped:0});expect(imported).toBe(1);
    await expect(service.sync(owner,'2026-10-14','2026-10-01')).rejects.toThrow('INVALID_DATE_RANGE');
    await expect(service.accounts({...owner,permissions:[]})).rejects.toThrow('FORBIDDEN');db.close();
  });
});
describe('fixed endpoint Enable Banking AIS adapter with synthetic protected credential',()=>{
  it('reads only an authorized session and exact EUR transactions without transfer calls or retries',async()=>{
    const account='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222',app='33333333-3333-4333-8333-333333333333';
    const privateKeyPem=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
    const calls:string[]=[];
    const http=async(input:unknown,init?:RequestInit)=>{
      const url=String(input);calls.push(`${init?.method} ${url}`);expect(url.startsWith('https://api.enablebanking.com/')).toBe(true);expect(init?.method).toBe('GET');
      const data=url.includes('/sessions/')?{status:'AUTHORIZED',accounts:[account],access:{valid_until:new Date(Date.now()+60000).toISOString()}}:url.includes('/details')?{uid:account,currency:'EUR',name:'Fictional account'}:{transactions:[{transaction_id:'fictional-tx',booking_date:'2026-10-14',transaction_amount:{currency:'EUR',amount:'-12.34'},remittance_information:['Fictional']} ]};
      return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
    };
    const adapter=new EnableBankingAisAdapter(http as typeof fetch),secret={applicationId:app,sessionId:session,privateKeyPem};
    expect((await adapter.accounts(secret,account))[0].name).toBe('Fictional account');
    expect((await adapter.transactions(secret,account,'2026-10-01','2026-10-14'))[0].amountMinor).toBe(-1234);
    expect(calls).toHaveLength(4);expect(calls.every(x=>x.startsWith('GET https://api.enablebanking.com/'))).toBe(true);
    await expect(adapter.accounts(secret,'https://evil.example')).rejects.toThrow('BANK_ACCOUNT_REF_INVALID');expect(calls).toHaveLength(4);
  });
});

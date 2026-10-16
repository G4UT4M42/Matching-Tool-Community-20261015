import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {open,rm} from 'node:fs/promises';
import {renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {WindowsDpapiProtector,type KeyProtector} from '../integrations/vault.js';
import {inspectVaultMember,readVaultMember,secureVaultDirectory} from '../integrations/vault-files.js';
import type {Principal} from '../payments/types.js';
import {checkedApplication,type BankApplication} from './consent-client.js';

export interface StoredBankApplication {revision:string;application:BankApplication}
/** Identity-only authority, excluded from financial backups. No callback/code/state persists. */
export class BankApplicationVault{
 constructor(readonly directory:string,private readonly protector:KeyProtector=new WindowsDpapiProtector()){}
 private scope(p:Principal){
  if([p.subject,p.workspace_id].some(x=>typeof x!=='string'||!x||x.length>256||/[\x00-\x1f\x7f]/.test(x)))throw new Error('BANK_APPLICATION_UNAVAILABLE');
  const scope=['bank-application-v1',p.workspace_id,p.subject],name=createHash('sha256').update(JSON.stringify(scope)).digest('hex')+'.credential';return{scope,file:join(this.directory,name)};
 }
 async get(p:Principal):Promise<StoredBankApplication|undefined>{
  const {scope,file}=this.scope(p);await secureVaultDirectory(this.directory,this.protector instanceof WindowsDpapiProtector);
  try{const raw=await readVaultMember(this.directory,file,65536);if(!raw)return;
   const envelope=JSON.parse(raw);if(envelope.version!==1||!['sandbox','live'].includes(envelope.environment)||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>60000||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext))throw new Error();
   const plain=this.protector.unprotect(Buffer.from(envelope.ciphertext,'base64'),Buffer.from(JSON.stringify([...scope,envelope.environment])));
   try{const value=JSON.parse(plain.toString('utf8')),application=checkedApplication(value.application);if(application.environment!==envelope.environment||typeof value.revision!=='string'||!/^[a-f0-9-]{36}$/i.test(value.revision))throw new Error();return{revision:value.revision,application};}finally{plain.fill(0);}
  }catch{throw new Error('BANK_APPLICATION_UNAVAILABLE');}
 }
 async put(p:Principal,application:BankApplication,guard:()=>void):Promise<StoredBankApplication>{
  application=checkedApplication(application);const {scope,file}=this.scope(p),value={revision:randomUUID(),application};
  await secureVaultDirectory(this.directory,this.protector instanceof WindowsDpapiProtector);await inspectVaultMember(this.directory,file,65536);
  guard();const plain=Buffer.from(JSON.stringify(value));let sealed:Buffer;try{sealed=this.protector.protect(plain,Buffer.from(JSON.stringify([...scope,application.environment])));}finally{plain.fill(0);}
  const temp=join(this.directory,randomBytes(32).toString('hex')+'.credential');
  try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify({version:1,environment:application.environment,ciphertext:sealed.toString('base64')}));await handle.sync();}finally{await handle.close();}
   await inspectVaultMember(this.directory,file,65536);guard();renameSync(temp,file);return value;
  }finally{sealed.fill(0);await rm(temp,{force:true});}
 }
 async remove(p:Principal,guard:()=>void):Promise<void>{const {file}=this.scope(p);const existing=await this.get(p);if(!existing)return;await inspectVaultMember(this.directory,file,65536);guard();unlinkSync(file);}
}

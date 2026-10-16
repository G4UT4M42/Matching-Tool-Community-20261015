import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WindowsDpapiProtector, type KeyProtector } from '../integrations/vault.js';
import { inspectVaultMember, readVaultMember, secureVaultDirectory } from '../integrations/vault-files.js';
import { checkedBankCredential } from './enablebanking-ais.js';
import type { CredentialResolver, Principal } from '../payments/types.js';

/** Immutable, scope-bound Windows credentials; SQL only contains opaque pointers. */
export class BankCredentialVault implements CredentialResolver{
 constructor(readonly directory:string,private readonly protector:KeyProtector=new WindowsDpapiProtector()){}
 private scope(subject:string,workspace:string,environment:'live'|'sandbox'='live'){
   if([subject,workspace].some(x=>typeof x!=='string'||!x||x.length>256||/[\x00-\x1f\x7f]/.test(x)))throw new Error('BANK_CREDENTIAL_UNAVAILABLE');
   const context=Buffer.from(JSON.stringify(['bank-v1',workspace,subject,'enablebanking-ais',environment]));
   return{context,legacyId:createHash('sha256').update(context).digest('hex'),subject,workspace,environment};
 }
 private file(ref:string){if(typeof ref!=='string'||!/^[a-f0-9]{64}$/.test(ref))throw new Error('BANK_CREDENTIAL_UNAVAILABLE');return join(this.directory,ref+'.credential');}
 private context(scope:ReturnType<BankCredentialVault['scope']>,ref:string){return Buffer.from(JSON.stringify(['bank-v2',scope.workspace,scope.subject,'enablebanking-ais',scope.environment,ref]));}
 async put(p:Principal,raw:unknown):Promise<string>{
   const credential=checkedBankCredential(raw);
   try{const key=createPrivateKey(credential.privateKeyPem);if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error();}catch{throw new Error('BANK_CREDENTIAL_UNAVAILABLE');}
   const scope=this.scope(p.subject,p.workspace_id,credential.environment??'live'),ref=createHash('sha256').update(randomUUID()).digest('hex'),file=this.file(ref);
   await secureVaultDirectory(this.directory,this.protector instanceof WindowsDpapiProtector);
   const plain=Buffer.from(JSON.stringify(credential));let sealed:Buffer;
   try{sealed=this.protector.protect(plain,this.context(scope,ref));}finally{plain.fill(0);}
   let created=false;
   try{
     // A new immutable file is durable before its pointer can enter SQLite.
     // Exclusive creation also prevents an accidental overwrite on collision.
     const handle=await open(file,'wx',0o600);created=true;
     try{await handle.writeFile(JSON.stringify({version:2,ciphertext:sealed.toString('base64')}));await handle.sync();}finally{await handle.close();}
     await inspectVaultMember(this.directory,file,65536);
   }catch(error){if(created)await rm(file,{force:true});throw error;}finally{sealed.fill(0);}
   return ref;
 }
 async resolve(input:Parameters<CredentialResolver['resolve']>[0]):Promise<unknown>{
   if(input.provider!=='enablebanking-ais'||!['live','sandbox'].includes(input.environment))throw new Error('BANK_CREDENTIAL_UNAVAILABLE');
   const scope=this.scope(input.subject,input.workspaceId,input.environment as 'live'|'sandbox'),file=this.file(input.vaultRef);
   try{
     await secureVaultDirectory(this.directory,this.protector instanceof WindowsDpapiProtector);
     const raw=await readVaultMember(this.directory,file,65536);if(!raw)throw new Error();
     const value=JSON.parse(raw);if(![1,2].includes(value.version)||typeof value.ciphertext!=='string'||value.ciphertext.length>60000||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext))throw new Error();
     if(value.version===1&&input.vaultRef!==scope.legacyId)throw new Error();
     const context=value.version===1?scope.context:this.context(scope,input.vaultRef);
     const plain=this.protector.unprotect(Buffer.from(value.ciphertext,'base64'),context);
     try{const credential=checkedBankCredential(JSON.parse(plain.toString('utf8')));if((credential.environment??'live')!==scope.environment)throw new Error();return credential;}finally{plain.fill(0);}
   }catch{throw new Error('BANK_CREDENTIAL_UNAVAILABLE');}
 }
 async remove(p:Principal,vaultRef?:string,environment:'live'|'sandbox'='live'):Promise<void>{
   const scope=this.scope(p.subject,p.workspace_id,environment),ref=vaultRef??scope.legacyId,file=this.file(ref);
   await secureVaultDirectory(this.directory,this.protector instanceof WindowsDpapiProtector);
   if(!await inspectVaultMember(this.directory,file,65536))return;
   // A reference supplied for another user cannot authorize deletion of its file.
   await this.resolve({subject:p.subject,workspaceId:p.workspace_id,provider:'enablebanking-ais',environment,vaultRef:ref});
   await rm(file,{force:true});
 }
}

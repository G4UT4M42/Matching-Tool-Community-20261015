#!/usr/bin/env node
// Ordinary startup/ACL diagnostics only. No application guards or security policy changes.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';

const started=performance.now();
const timeoutMs=20000;
const identityNames=['SystemRoot','SYSTEMROOT','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA'];
const vaultNames=['SystemRoot','SYSTEMROOT','WINDIR','SystemDrive','USERPROFILE','TEMP','TMP','LOCALAPPDATA'];
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
const hash=value=>createHash('sha256').update(value).digest('hex');
if(process.platform!=='win32')throw new Error('Windows diagnostic only');
const systemRoot=process.env.SystemRoot??process.env.SYSTEMROOT;
if(!systemRoot||!isAbsolute(systemRoot))throw new Error('Trusted Windows system directory unavailable');
const executable=join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
if(!existsSync(executable)||!lstatSync(executable).isFile())throw new Error('Trusted PowerShell unavailable');
if(!process.env.RUNNER_TEMP||!isAbsolute(process.env.RUNNER_TEMP))throw new Error('Absolute isolated RUNNER_TEMP required');
const temp=realpathSync(process.env.RUNNER_TEMP);
if(!lstatSync(temp).isDirectory())throw new Error('RUNNER_TEMP must be a directory');
const work=mkdtempSync(join(temp,'matching-community-acl-diag-'));
if(!inside(temp,realpathSync(work)))throw new Error('Diagnostic directory escaped temporary root');
const output=resolve(process.argv[2]??join(temp,'windows-acl-diagnostics.json'));
if(!inside(temp,output)||existsSync(output))throw new Error('New output must remain inside RUNNER_TEMP');
const minimal=names=>Object.fromEntries(names.filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
const environments={inherited:{...process.env},identity_minimal:minimal(identityNames),vault_minimal:minimal(vaultNames)};
const baselineEnvironments=Object.keys(environments);
environments.identity_system_modules={...minimal(identityNames),PSModulePath:join(systemRoot,'System32','WindowsPowerShell','v1.0','Modules'),PATH:join(systemRoot,'System32')};
const startup=String.raw`
$ErrorActionPreference='Stop'
Write-Output 'DIAG_STARTED'
Write-Output 'DIAG_STARTUP_COMPLETE'
`;
const acl=String.raw`
$ErrorActionPreference='Stop'
Write-Output 'DIAG_STARTED'
$directory=$env:MATCHING_DIAGNOSTIC_DIRECTORY
$item=Get-Item -LiteralPath $directory -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'DIAG_INVALID_DIRECTORY' }
if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'DIAG_DIRECTORY_NOT_EMPTY' }
Write-Output 'DIAG_DIRECTORY_CHECKED'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed=@($user.Value,$system.Value)
Write-Output 'DIAG_IDENTITY_READY'
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($user)
$security.SetAccessRuleProtection($true,$false)
foreach ($principal in @($user,$system)) {
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
}
Write-Output 'DIAG_ACL_CONSTRUCTED'
Set-Acl -LiteralPath $directory -AclObject $security
Write-Output 'DIAG_ACL_APPLIED'
$actual=Get-Acl -LiteralPath $directory
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'DIAG_OWNER_OR_INHERITANCE' }
$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if ($rules.Count -lt 1 -or $rules.Count -gt 2) { throw 'DIAG_RULE_COUNT' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -notin $allowed -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'DIAG_UNEXPECTED_RULE' }
}
foreach ($principal in @($user,$system)) { if (@($rules | Where-Object {$_.IdentityReference.Value -eq $principal.Value}).Count -ne 1) { throw 'DIAG_MISSING_PRINCIPAL' } }
if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'DIAG_DIRECTORY_CHANGED' }
Write-Output 'DIAG_ACL_VERIFIED'
`;
const cases=[];
function run(name,kind,environment,stdin,encoded=false){
  if(performance.now()-started>230000)throw new Error('Diagnostic overall time budget exceeded');
  const env={...environments[environment]};
  if(kind==='acl'){
    const directory=join(work,name);mkdirSync(directory);
    if(!inside(work,realpathSync(directory))||lstatSync(directory).isSymbolicLink())throw new Error('Unsafe diagnostic directory');
    env.MATCHING_DIAGNOSTIC_DIRECTORY=directory;
  }
  const body=kind==='acl'?acl:startup;
  const script='try {\n'+body+String.raw`
} catch {
  if ($_.FullyQualifiedErrorId -match 'CouldNotAutoLoadMatchingModule') { Write-Output 'DIAG_ERROR_MODULE_AUTOLOAD' }
  elseif ($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [UnauthorizedAccessException]) { Write-Output 'DIAG_ERROR_PERMISSION' }
  elseif ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { Write-Output 'DIAG_ERROR_COMMAND_NOT_FOUND' }
  else { Write-Output 'DIAG_ERROR_OTHER' }
  exit 1
}
`;
  const args=['-NoLogo','-NoProfile','-NonInteractive',...(encoded?['-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]:['-Command',script])];
  const before=performance.now();
  const child=spawnSync(executable,args,{env,windowsHide:true,encoding:'utf8',timeout:timeoutMs,maxBuffer:65536,...(stdin==='ignore'?{stdio:['ignore','pipe','pipe']}:{})});
  const stdout=child.stdout??'',stderr=child.stderr??'';
  const markers=['DIAG_STARTED','DIAG_STARTUP_COMPLETE','DIAG_DIRECTORY_CHECKED','DIAG_IDENTITY_READY','DIAG_ACL_CONSTRUCTED','DIAG_ACL_APPLIED','DIAG_ACL_VERIFIED','DIAG_ERROR_MODULE_AUTOLOAD','DIAG_ERROR_PERMISSION','DIAG_ERROR_COMMAND_NOT_FOUND','DIAG_ERROR_OTHER'].filter(marker=>stdout.split(/\r?\n/).includes(marker));
  const expected=kind==='acl'?'DIAG_ACL_VERIFIED':'DIAG_STARTUP_COMPLETE';
  const result={name,kind,environment,stdin,transport:encoded?'encoded_command':'command',timeout_ms:timeoutMs,elapsed_ms:Math.round((performance.now()-before)*1000)/1000,status:child.status,signal:child.signal??null,error_code:typeof child.error?.code==='string'?child.error.code:null,markers,passed:!child.error&&child.status===0&&markers.includes(expected),stdout_bytes:Buffer.byteLength(stdout),stderr_bytes:Buffer.byteLength(stderr),stderr_sha256:stderr?hash(stderr):null};
  cases.push(result);
  // Save after each bounded process so a later timeout does not discard prior evidence.
  writeFileSync(output,JSON.stringify(report(),null,2)+'\n',{encoding:'utf8',flag:'w'});
}
function report(){return{schema:'matching-community-windows-acl-diagnostic-v1',node:process.versions.node,platform:process.platform,arch:process.arch,executable:'SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe',identity_environment_names:identityNames,vault_environment_names:vaultNames,system_module_control:{PSModulePath:'SystemRoot/System32/WindowsPowerShell/v1.0/Modules',PATH:'SystemRoot/System32'},case_timeout_ms:timeoutMs,elapsed_ms:Math.round(performance.now()-started),cases,complete:cases.length===11,failed_cases:cases.filter(c=>!c.passed).length,scope:'Only startup and current-user/SYSTEM protected empty directories; no application imports, profiles, credentials, environment values, SIDs, raw stderr or security-policy changes. Fresh diagnostic directories retained; no cleanup performed.'};}
for(const environment of baselineEnvironments)for(const stdin of environment==='vault_minimal'?['pipe']:['pipe','ignore'])run('startup_'+environment+'_'+stdin,'startup',environment,stdin);
run('startup_identity_encoded_pipe','startup','identity_minimal','pipe',true);
for(const environment of baselineEnvironments)run('acl_'+environment,'acl',environment,'pipe');
run('acl_identity_minimal_ignore','acl','identity_minimal','ignore');
run('acl_identity_system_modules','acl','identity_system_modules','pipe');
writeFileSync(output,JSON.stringify(report(),null,2)+'\n',{encoding:'utf8',flag:'w'});
console.log(JSON.stringify({complete:true,cases:cases.length,failed:cases.filter(c=>!c.passed).length,elapsed_ms:Math.round(performance.now()-started)}));
// Probe failures are evidence, not a reason to prevent artifact upload.

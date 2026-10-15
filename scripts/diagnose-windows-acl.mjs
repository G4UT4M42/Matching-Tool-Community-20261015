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
const groups={
  A:['USERNAME','USERDOMAIN','COMPUTERNAME','USERDOMAIN_ROAMINGPROFILE'],
  B:['APPDATA','ProgramData','ALLUSERSPROFILE','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','PUBLIC','HOMEDRIVE','HOMEPATH'],
  C:['OS','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL','PROCESSOR_REVISION'],
};
const allNames=Object.values(groups).flat();
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
const base={...minimal(identityNames),PSModulePath:join(systemRoot,'System32','WindowsPowerShell','v1.0','Modules'),PATH:join(systemRoot,'System32'),PATHEXT:'.COM;.EXE;.BAT;.CMD'};
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
const cases=[];let complete=false,decision=null;
function run(name,kind,names=[]){
  if(performance.now()-started>230000)throw new Error('Diagnostic overall time budget exceeded');
  if(cases.length>=11)throw new Error('Diagnostic case budget exceeded');
  if(names.some(name=>!allNames.includes(name)))throw new Error('Unapproved diagnostic environment name');
  const env={...base,...minimal(names)};
  if(kind==='acl'){
    const directory=join(work,name);mkdirSync(directory);
    if(!inside(work,realpathSync(directory))||lstatSync(directory).isSymbolicLink())throw new Error('Unsafe diagnostic directory');
    env.MATCHING_DIAGNOSTIC_DIRECTORY=directory;
  }
  const body=kind==='acl'?acl:startup;
  const script=String.raw`[Console]::WriteLine('DIAG_CONSOLE_ENTERED'); [Console]::Out.Flush()
try {
`+body+String.raw`
} catch {
  if ($_.FullyQualifiedErrorId -match 'CouldNotAutoLoadMatchingModule') { Write-Output 'DIAG_ERROR_MODULE_AUTOLOAD' }
  elseif ($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [UnauthorizedAccessException]) { Write-Output 'DIAG_ERROR_PERMISSION' }
  elseif ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { Write-Output 'DIAG_ERROR_COMMAND_NOT_FOUND' }
  else { Write-Output 'DIAG_ERROR_OTHER' }
  exit 1
}
`;
  const args=['-NoLogo','-NoProfile','-NonInteractive','-Command',script];
  const before=performance.now();
  const child=spawnSync(executable,args,{env,windowsHide:true,encoding:'utf8',timeout:timeoutMs,maxBuffer:65536});
  const stdout=child.stdout??'',stderr=child.stderr??'';
  const markers=['DIAG_CONSOLE_ENTERED','DIAG_STARTED','DIAG_STARTUP_COMPLETE','DIAG_DIRECTORY_CHECKED','DIAG_IDENTITY_READY','DIAG_ACL_CONSTRUCTED','DIAG_ACL_APPLIED','DIAG_ACL_VERIFIED','DIAG_ERROR_MODULE_AUTOLOAD','DIAG_ERROR_PERMISSION','DIAG_ERROR_COMMAND_NOT_FOUND','DIAG_ERROR_OTHER'].filter(marker=>stdout.split(/\r?\n/).includes(marker));
  const expected=kind==='acl'?'DIAG_ACL_VERIFIED':'DIAG_STARTUP_COMPLETE';
  const result={name,kind,additional_environment_names:names,present_additional_names:names.filter(key=>Boolean(process.env[key])),stdin:'pipe',transport:'command',timeout_ms:timeoutMs,elapsed_ms:Math.round((performance.now()-before)*1000)/1000,status:child.status,signal:child.signal??null,error_code:typeof child.error?.code==='string'?child.error.code:null,markers,passed:!child.error&&child.status===0&&markers.includes(expected),stdout_bytes:Buffer.byteLength(stdout),stderr_bytes:Buffer.byteLength(stderr),stderr_sha256:stderr?hash(stderr):null};
  cases.push(result);
  // Save after each bounded process so a later timeout does not discard prior evidence.
  writeFileSync(output,JSON.stringify(report(),null,2)+'\n',{encoding:'utf8',flag:'w'});
  return result;
}
function report(){return{schema:'matching-community-windows-acl-environment-diagnostic-v2',node:process.versions.node,platform:process.platform,arch:process.arch,executable:'SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe',base_environment_names:identityNames,approved_groups:groups,trusted_controls:{PSModulePath:'SystemRoot/System32/WindowsPowerShell/v1.0/Modules',PATH:'SystemRoot/System32',PATHEXT:'.COM;.EXE;.BAT;.CMD'},case_timeout_ms:timeoutMs,maximum_cases:11,elapsed_ms:Math.round(performance.now()-started),cases,complete,decision,failed_cases:cases.filter(c=>!c.passed).length,scope:'Only approved ordinary Windows environment groups and current-user/SYSTEM protected empty directories. No arbitrary inherited environment, application imports, profiles, credentials, environment values, SIDs, raw stderr or security-policy changes. Direct console marker precedes cmdlets. Fresh diagnostic directories retained; no cleanup performed.'};}
const baseline=run('trusted_baseline_startup','startup');
const all=run('known_windows_all_startup','startup',allNames);
const allAcl=run('known_windows_all_acl','acl',allNames);
const singles=Object.entries(groups).map(([group,names])=>({group,names,result:run('group_'+group+'_startup','startup',names)}));
let candidate=baseline.passed?[]:all.passed?[...allNames]:null;
let remaining=4;
const passing=singles.filter(item=>item.result.passed).sort((a,b)=>a.names.length-b.names.length);
if(!baseline.passed&&passing.length)candidate=[...passing[0].names];
if(!baseline.passed&&!passing.length&&all.passed){
  const pairs=[['A','B'],['A','C'],['B','C']];
  for(const pair of pairs){
    const names=pair.flatMap(group=>groups[group]);
    const probe=run('pair_'+pair.join('')+'_startup','startup',names);remaining--;
    if(probe.passed&&(candidate===null||names.length<candidate.length))candidate=names;
  }
}
let refinement=0;
while(candidate&&candidate.length>1&&remaining>0&&!baseline.passed){
  const original=[...candidate],middle=Math.ceil(original.length/2),halves=[original.slice(0,middle),original.slice(middle)];
  let narrowed=false;
  for(const half of halves){
    if(!remaining)break;
    const probe=run('refine_'+(++refinement)+'_startup','startup',half);remaining--;
    if(probe.passed){candidate=half;narrowed=true;break;}
  }
  if(!narrowed)break; // Known working superset retained; no guessed individual cause.
}
if(candidate!==null){
  const finalAcl=run('selected_allowlist_acl','acl',candidate);
  decision={working_startup_additions:candidate,strict_acl_passed:finalAcl.passed,classification:finalAcl.passed?'MEASURED_SAFE_ALLOWLIST':'STARTUP_PASSES_ACL_UNQUALIFIED',causal_limit:'A passing allowlist is sufficient for this runner; an omitted single variable is causal only where paired measured subsets establish it.'};
}else decision={working_startup_additions:null,strict_acl_passed:false,classification:'NO_APPROVED_GROUP_CONFIGURATION_PASSED',causal_limit:'No broader or sensitive environment inheritance attempted.'};
complete=true;
writeFileSync(output,JSON.stringify(report(),null,2)+'\n',{encoding:'utf8',flag:'w'});
console.log(JSON.stringify({complete,cases:cases.length,failed:cases.filter(c=>!c.passed).length,classification:decision.classification,elapsed_ms:Math.round(performance.now()-started)}));
// Probe failures are evidence, not a reason to prevent artifact upload.

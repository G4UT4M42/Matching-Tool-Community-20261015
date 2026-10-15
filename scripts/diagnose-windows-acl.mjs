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
const marker=name=>`[Console]::WriteLine('${name}'); [Console]::Out.Flush()\n`;
const imports=modules=>modules.map(name=>`$module=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','Modules','Microsoft.PowerShell.${name}','Microsoft.PowerShell.${name}.psd1')
${marker('DIAG_IMPORT_'+name.toUpperCase()+'_BEGIN')}$null=Import-Module -Name $module -ErrorAction Stop
${marker('DIAG_IMPORT_'+name.toUpperCase()+'_COMPLETE')}`).join('');
const identities=String.raw`
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed=@($user.Value,$system.Value)
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($user)
$security.SetAccessRuleProtection($true,$false)
foreach ($principal in @($user,$system)) {
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  [void]$security.AddAccessRule($rule)
}
`;
const verify=String.raw`
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'DIAG_OWNER_OR_INHERITANCE' }
$rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 2) { throw 'DIAG_RULE_COUNT' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -notin $allowed -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'DIAG_UNEXPECTED_RULE' }
}
foreach ($principal in @($user,$system)) {
  $matching=0
  foreach ($rule in $rules) { if ($rule.IdentityReference.Value -eq $principal.Value) { $matching++ } }
  if ($matching -ne 1) { throw 'DIAG_MISSING_PRINCIPAL' }
}
`;
const cmdletAcl=String.raw`
$directory=$env:MATCHING_DIAGNOSTIC_DIRECTORY
$item=Get-Item -LiteralPath $directory -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'DIAG_INVALID_DIRECTORY' }
if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'DIAG_DIRECTORY_NOT_EMPTY' }
`+marker('DIAG_DIRECTORY_CHECKED')+identities+marker('DIAG_ACL_CONSTRUCTED')+String.raw`
Set-Acl -LiteralPath $directory -AclObject $security
`+marker('DIAG_ACL_APPLIED')+String.raw`
$actual=Get-Acl -LiteralPath $directory
`+verify+String.raw`
if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'DIAG_DIRECTORY_CHANGED' }
`+marker('DIAG_ACL_VERIFIED');
const dotnetAcl=String.raw`
$directory=[IO.DirectoryInfo]::new($env:MATCHING_DIAGNOSTIC_DIRECTORY)
if (!$directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $directory.GetFileSystemInfos().Length -ne 0) { throw 'DIAG_INVALID_DIRECTORY' }
`+marker('DIAG_DIRECTORY_CHECKED')+identities+marker('DIAG_ACL_CONSTRUCTED')+String.raw`
[void]$directory.SetAccessControl($security)
`+marker('DIAG_ACL_APPLIED')+String.raw`
$actual=$directory.GetAccessControl()
`+verify+String.raw`
if ($directory.GetFileSystemInfos().Length -ne 0) { throw 'DIAG_DIRECTORY_CHANGED' }
`+marker('DIAG_ACL_VERIFIED');
const dpapi=marker('DIAG_DPAPI_ASSEMBLY_BEGIN')+String.raw`
[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
`+marker('DIAG_DPAPI_ASSEMBLY_LOADED')+String.raw`
$plain=[byte[]](67,79,77,77,85,78,73,84,89)
$entropy=[byte[]](1,2,3,4)
$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
`+marker('DIAG_DPAPI_PROTECTED')+String.raw`
$decoded=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if ($decoded.Length -ne $plain.Length) { throw 'DIAG_DPAPI_LENGTH' }
for ($i=0;$i -lt $plain.Length;$i++) { if ($decoded[$i] -ne $plain[$i]) { throw 'DIAG_DPAPI_BYTES' } }
`+marker('DIAG_DPAPI_ROUNDTRIP')+String.raw`
$rejected=$false
try { $null=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[byte[]](9,8,7,6),[Security.Cryptography.DataProtectionScope]::CurrentUser) }
catch [Security.Cryptography.CryptographicException] { $rejected=$true }
if (!$rejected) { throw 'DIAG_DPAPI_ENTROPY_NOT_REJECTED' }
`+marker('DIAG_DPAPI_WRONG_ENTROPY_REJECTED');
const probes=[
  {name:'console_only',body:marker('DIAG_CONSOLE_ONLY_COMPLETE'),expected:'DIAG_CONSOLE_ONLY_COMPLETE'},
  {name:'explicit_utility_write_output',body:imports(['Utility'])+"Write-Output 'DIAG_WRITE_OUTPUT_COMPLETE'",expected:'DIAG_WRITE_OUTPUT_COMPLETE'},
  {name:'explicit_management_directory',directory:true,body:imports(['Management'])+String.raw`$item=Get-Item -LiteralPath $env:MATCHING_DIAGNOSTIC_DIRECTORY -Force
if (!$item.PSIsContainer -or @((Get-ChildItem -LiteralPath $env:MATCHING_DIAGNOSTIC_DIRECTORY -Force)).Count -ne 0) { throw 'DIAG_INVALID_DIRECTORY' }
`+marker('DIAG_MANAGEMENT_COMPLETE'),expected:'DIAG_MANAGEMENT_COMPLETE'},
  {name:'explicit_security_import',body:imports(['Security'])+marker('DIAG_SECURITY_COMPLETE'),expected:'DIAG_SECURITY_COMPLETE'},
  {name:'explicit_modules_strict_acl',directory:true,body:imports(['Utility','Management','Security'])+cmdletAcl,expected:'DIAG_ACL_VERIFIED'},
  {name:'dotnet_strict_acl',directory:true,body:dotnetAcl,expected:'DIAG_ACL_VERIFIED'},
  {name:'dotnet_dpapi_synthetic',body:dpapi,expected:'DIAG_DPAPI_WRONG_ENTROPY_REJECTED'},
];
const cases=[];let complete=false;
function run(probe){
  if(cases.length>=7||performance.now()-started>150000)throw new Error('Diagnostic budget exceeded');
  const env={...base};
  if(probe.directory){
    const directory=join(work,probe.name);mkdirSync(directory);
    if(!inside(work,realpathSync(directory))||lstatSync(directory).isSymbolicLink())throw new Error('Unsafe diagnostic directory');
    env.MATCHING_DIAGNOSTIC_DIRECTORY=directory;
  }
  const script=marker('DIAG_CONSOLE_ENTERED')+"$ErrorActionPreference='Stop'\ntry {\n"+probe.body+String.raw`
} catch {
  if ($_.FullyQualifiedErrorId -eq 'MethodNotFound') { [Console]::WriteLine('DIAG_ERROR_METHOD_NOT_FOUND') }
  elseif ($_.Exception.GetBaseException() -is [ArgumentException]) { [Console]::WriteLine('DIAG_ERROR_ARGUMENT') }
  elseif ($_.Exception.GetBaseException() -is [Security.AccessControl.PrivilegeNotHeldException]) { [Console]::WriteLine('DIAG_ERROR_PRIVILEGE_NOT_HELD') }
  elseif ($_.Exception.GetBaseException() -is [UnauthorizedAccessException]) { [Console]::WriteLine('DIAG_ERROR_PERMISSION') }
  elseif ($_.Exception.GetBaseException() -is [NotSupportedException]) { [Console]::WriteLine('DIAG_ERROR_API_UNSUPPORTED') }
  elseif ($_.FullyQualifiedErrorId -match 'CouldNotAutoLoadMatchingModule') { [Console]::WriteLine('DIAG_ERROR_MODULE_AUTOLOAD') }
  elseif ($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [UnauthorizedAccessException]) { [Console]::WriteLine('DIAG_ERROR_PERMISSION') }
  elseif ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { [Console]::WriteLine('DIAG_ERROR_COMMAND_NOT_FOUND') }
  else { [Console]::WriteLine('DIAG_ERROR_OTHER') }
  [Console]::Out.Flush()
  exit 1
}
`;
  const before=performance.now();
  const child=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,encoding:'utf8',timeout:timeoutMs,maxBuffer:65536});
  const stdout=child.stdout??'',stderr=child.stderr??'';
  const allowed=['DIAG_CONSOLE_ENTERED','DIAG_CONSOLE_ONLY_COMPLETE','DIAG_WRITE_OUTPUT_COMPLETE','DIAG_MANAGEMENT_COMPLETE','DIAG_SECURITY_COMPLETE','DIAG_DIRECTORY_CHECKED','DIAG_ACL_CONSTRUCTED','DIAG_ACL_APPLIED','DIAG_ACL_VERIFIED','DIAG_DPAPI_ASSEMBLY_BEGIN','DIAG_DPAPI_ASSEMBLY_LOADED','DIAG_DPAPI_PROTECTED','DIAG_DPAPI_ROUNDTRIP','DIAG_DPAPI_WRONG_ENTROPY_REJECTED','DIAG_ERROR_METHOD_NOT_FOUND','DIAG_ERROR_ARGUMENT','DIAG_ERROR_PRIVILEGE_NOT_HELD','DIAG_ERROR_API_UNSUPPORTED','DIAG_ERROR_MODULE_AUTOLOAD','DIAG_ERROR_PERMISSION','DIAG_ERROR_COMMAND_NOT_FOUND','DIAG_ERROR_OTHER',...['UTILITY','MANAGEMENT','SECURITY'].flatMap(module=>['DIAG_IMPORT_'+module+'_BEGIN','DIAG_IMPORT_'+module+'_COMPLETE'])];
  const lines=stdout.split(/\r?\n/).filter(Boolean),markers=lines.filter(line=>allowed.includes(line));
  cases.push({name:probe.name,timeout_ms:timeoutMs,elapsed_ms:Math.round((performance.now()-before)*1000)/1000,status:child.status,signal:child.signal??null,error_code:typeof child.error?.code==='string'?child.error.code:null,markers,passed:!child.error&&child.status===0&&markers.includes(probe.expected)&&lines.length===markers.length,unrecognized_stdout_lines:lines.length-markers.length,stdout_bytes:Buffer.byteLength(stdout),stderr_bytes:Buffer.byteLength(stderr),stderr_sha256:stderr?hash(stderr):null});
  writeFileSync(output,JSON.stringify(report(),null,2)+'\n',{encoding:'utf8',flag:'w'});
}
function report(){return{schema:'matching-community-windows-module-api-diagnostic-v3',node:process.versions.node,platform:process.platform,arch:process.arch,executable:'SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe',base_environment_names:identityNames,trusted_controls:{PSModulePath:'SystemRoot/System32/WindowsPowerShell/v1.0/Modules',PATH:'SystemRoot/System32',PATHEXT:'.COM;.EXE;.BAT;.CMD'},case_timeout_ms:timeoutMs,maximum_cases:7,elapsed_ms:Math.round(performance.now()-started),cases,complete,failed_cases:cases.filter(c=>!c.passed).length,scope:'Fixed trusted system-module imports versus module-independent .NET ACL and synthetic current-user DPAPI. Exact protected current-user/SYSTEM ACL only; no arbitrary environment inheritance, application imports, profiles, credentials, environment values, SIDs, raw stderr, policy changes or cleanup. Every .NET return is assigned or suppressed to avoid implicit output formatting.'};}
for(const probe of probes)run(probe);
complete=true;
writeFileSync(output,JSON.stringify(report(),null,2)+'\n',{encoding:'utf8',flag:'w'});
console.log(JSON.stringify({complete,cases:cases.length,failed:cases.filter(c=>!c.passed).length,elapsed_ms:Math.round(performance.now()-started)}));
// Probe failures are evidence, not a reason to prevent artifact upload.

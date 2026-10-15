import {describe,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {win32} from 'node:path';
import {trustedWindowsPowerShellEnvironment,trustedWindowsPowerShellPreamble} from '../src/core/windows-powershell.js';

describe('trusted ordinary Windows PowerShell process boundary',()=>{
  it('constructs system-only discovery paths without forwarding parent secrets or runtime hooks',()=>{
    const source={SystemRoot:'C:\\Windows',TEMP:'C:\\Synthetic\\Temp',PSModulePath:'C:\\Synthetic\\IncompatibleModules',PATH:'C:\\Synthetic\\UntrustedBin',PATHEXT:'.PS1',EXAMPLE_SECRET:'synthetic-private-only',NODE_OPTIONS:'synthetic-hook',DOTNET_STARTUP_HOOKS:'synthetic-hook'};
    const before={...source},environment=trustedWindowsPowerShellEnvironment(source);
    expect(source).toEqual(before);
    expect(environment.TEMP).toBe(source.TEMP);
    expect(environment.PSModulePath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    expect(environment.PATH).toBe('C:\\Windows\\System32');
    expect(environment.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
    for(const name of ['EXAMPLE_SECRET','NODE_OPTIONS','DOTNET_STARTUP_HOOKS'])expect(environment).not.toHaveProperty(name);
    expect(JSON.stringify(environment)).not.toContain('synthetic-private-only');
    expect(JSON.stringify(environment)).not.toContain('synthetic-hook');
  });
  it('supports the existing uppercase system-root spelling and rejects absent or relative roots',()=>{
    expect(trustedWindowsPowerShellEnvironment({SYSTEMROOT:'C:\\Windows'}).SystemRoot).toBe('C:\\Windows');
    expect(()=>trustedWindowsPowerShellEnvironment({})).toThrow('PROTECTION_UNAVAILABLE');
    expect(()=>trustedWindowsPowerShellEnvironment({SystemRoot:'relative-synthetic'})).toThrow('PROTECTION_UNAVAILABLE');
  });
  it('actually imports trusted modules and observes no synthetic secret or hook in the Windows child',()=>{
    if(process.platform!=='win32')return;
    const environment=trustedWindowsPowerShellEnvironment({...process.env,PSModulePath:'C:\\Synthetic\\IncompatibleModules',PATH:'C:\\Synthetic\\UntrustedBin',EXAMPLE_SECRET:'synthetic-private-only',NODE_OPTIONS:'synthetic-hook',DOTNET_STARTUP_HOOKS:'synthetic-hook'});
    const script=trustedWindowsPowerShellPreamble+String.raw`
if ($env:EXAMPLE_SECRET -or $env:NODE_OPTIONS -or $env:DOTNET_STARTUP_HOOKS) { throw 'Unexpected inherited process state' }
$security=[Security.AccessControl.DirectorySecurity]::new()
if (!$security) { throw 'Missing ordinary security API' }
Write-Output 'SYNTHETIC_TRUSTED_MODULES_VERIFIED'
`;
    const result=spawnSync(win32.join(environment.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:environment,windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:65536});
    expect(result.error).toBeUndefined();expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('SYNTHETIC_TRUSTED_MODULES_VERIFIED');
  },20000);
});

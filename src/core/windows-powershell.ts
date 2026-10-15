import {win32} from 'node:path';

const environmentNames=['SystemRoot','SYSTEMROOT','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA'] as const;

/** Fixed Windows system modules, independent of parent shell module discovery. */
export const trustedWindowsPowerShellPreamble="$ErrorActionPreference='Stop'\n"+['Utility','Management','Security'].map(name=>
  `$matchingModule=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','Modules','Microsoft.PowerShell.${name}','Microsoft.PowerShell.${name}.psd1')\n$null=Import-Module -Name $matchingModule -ErrorAction Stop\n`,
).join('');

/** Never forward parent credentials, runtime hooks or arbitrary executable/module paths. */
export function trustedWindowsPowerShellEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const systemRoot=source.SystemRoot??source.SYSTEMROOT;
  if(!systemRoot||!win32.isAbsolute(systemRoot))throw new Error('PROTECTION_UNAVAILABLE');
  const environment:NodeJS.ProcessEnv={};
  for(const name of environmentNames)if(source[name])environment[name]=source[name];
  environment.SystemRoot=systemRoot;
  environment.PSModulePath=win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','Modules');
  environment.PATH=win32.join(systemRoot,'System32');
  environment.PATHEXT='.COM;.EXE;.BAT;.CMD';
  return environment;
}

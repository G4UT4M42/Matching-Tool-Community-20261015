import { spawn } from 'node:child_process';

export type GeorgeAuthPromptKind = 'login' | 'release';

const displayedChallenges = new Set<string>();

function safeVerificationCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return /^[A-Z0-9]{4,12}$/.test(normalized) ? normalized : null;
}

export function buildGeorgeAuthPromptMessage(
  kind: GeorgeAuthPromptKind,
  verificationCode?: string | null,
): string {
  const code = safeVerificationCode(verificationCode);
  const action = kind === 'release'
    ? 'George wartet auf die s-Identity-Freigabe des vorbereiteten Zahlungspakets.'
    : 'George benötigt jetzt Ihre s-Identity-Freigabe für die Anmeldung.';
  const codeHint = code
    ? `\n\nReferenz-/Verifizierungscode: ${code}\n\nBitte nur freigeben, wenn derselbe Code in s-Identity angezeigt wird.`
    : '\n\nBitte prüfen und bestätigen Sie die Anfrage jetzt in s-Identity.';
  return `${action}${codeHint}\n\nPIN oder Freigabecode niemals in das Matching Tool eingeben.`;
}

export function notifyGeorgeAuthRequired(
  kind: GeorgeAuthPromptKind,
  verificationCode?: string | null,
): boolean {
  if (process.platform !== 'win32') return false;
  const code = safeVerificationCode(verificationCode);
  const challengeKey = `${kind}:${code ?? 'without-code'}`;
  if (displayedChallenges.has(challengeKey)) return false;
  displayedChallenges.add(challengeKey);

  const message = `MATCHING TOOL - George-Autorisierung erforderlich\n\n${buildGeorgeAuthPromptMessage(kind, code)}`;

  try {
    // msg.exe targets the active interactive Windows session. Unlike a GUI
    // window spawned from a background Node process, it cannot disappear on a
    // non-interactive desktop and is therefore suitable for unattended runs.
    const child = spawn('msg.exe', ['*', '/TIME:300', message], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    displayedChallenges.delete(challengeKey);
    return false;
  }
}

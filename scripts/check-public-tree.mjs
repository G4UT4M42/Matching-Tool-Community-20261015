#!/usr/bin/env node
/**
 * Conservative admission gate for source, staged blobs and local release files.
 * No private identity or domain patterns belong in this redistributable script.
 * A private, OUT-OF-REPOSITORY JSON blocklist can supplement the generic rules.
 * This is preflight automation, not an independent privacy/legal signoff.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const staged = process.argv.includes('--staged');
const indexAll = process.argv.includes('--index-all');
const untracked = process.argv.includes('--include-untracked');
const requirePrivate = process.argv.includes('--require-private-blocklist');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const violations = [];
const inside = (parent, target) => {
  const diff = relative(parent, target);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
};

function loadPrivateTerms() {
  const config = process.env.MATCHING_PRIVATE_BLOCKLIST_FILE;
  if (!config) {
    if (requirePrivate) throw new Error('private blocklist is required for independent release preflight');
    return [];
  }
  const abs = resolve(config);
  if (inside(root, abs)) throw new Error('private blocklist must be outside the repository');
  const terms = JSON.parse(readFileSync(abs, 'utf8'));
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > 4096 ||
      !terms.every(term => typeof term === 'string' && term.trim().length >= 4 && term.length <= 256)) {
    throw new Error('invalid private blocklist configuration');
  }
  return terms.map(term => term.toLowerCase());
}

const bannedPath = /(^|\/)(?:Belege|data|runtime|logs|backups|browser-profiles|profiles|invoices|bank-statements)\//i;
const bannedExt = /\.(?:db|sqlite|sqlite3|wal|shm|pdf|zip|7z|rar|xls|xlsx|xlsm|csv|pem|p12|pfx|key|jks|keystore|exe|dll|node|dmp|bak|log)$/i;
const rules = [
  ['credential-token', /(?:sk-[A-Za-z0-9_-]{18,}|gh[pousr]_[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})/],
  ['oauth-client-secret', /(?:client_secret|refresh_token|private_key)\s*[:=]\s*['"](?!(?:example|REPLACE|SYNTHETIC))[A-Za-z0-9_+/.=-]{24,}/i],
  ['sensitive-host-path', new RegExp(String.raw`(?:[A-Z]:\\` + 'U' + 'sers' + String.raw`\\|[A-Z]:\\` + 'Google' + '-DRIVE' + String.raw`\\|\\\\[^\n]+\\` + 'U' + 'sers' + String.raw`\\)`, 'i')],
  ['real-email-address', /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['possible-bank-iban', /\b(?:AT\d{18}|DE\d{20}|GB\d{2}[A-Z]{4}\d{14}|NL\d{2}[A-Z]{4}\d{10})\b/i],
  ['possible-tax-id', /\bATU\d{8}\b/i],
  ['cloud-account-reference', /\b[A-F0-9]{6}(?:-[A-F0-9]{6}){2}\b|gen-lang-client-\d{6,}/i],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
];

try {
  const privateTerms = loadPrivateTerms();
  const listed = (staged&&!indexAll ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    : git('ls-files', '--cached')) + (untracked ? '\n' + git('ls-files', '--others', '--exclude-standard') : '');
  const paths = [...new Set(listed.split(/\r?\n/).filter(Boolean))].sort();
  for (const name of paths) {
    const normalized = name.replaceAll('\\', '/');
    if (normalized.includes('\0') || normalized.split('/').includes('..') ||
        bannedPath.test(normalized) || bannedExt.test(normalized)) {
      violations.push(normalized + ': forbidden-path-or-extension');
      continue;
    }
    const absolute = resolve(root, name);
    if (!inside(root, absolute)) {
      violations.push(normalized + ': path-traversal');
      continue;
    }
    let source;
    try {
      if (staged||indexAll) {
        source = execFileSync('git', ['show', ':' + name], {
          cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        if (lstatSync(absolute).isSymbolicLink() || !inside(root, realpathSync(absolute))) {
          violations.push(normalized + ': unsafe-link');
          continue;
        }
        source = readFileSync(absolute, 'utf8');
      }
    } catch {
      violations.push(normalized + ': unreadable');
      continue;
    }
    if (source.includes('\0')) {
      violations.push(normalized + ': binary-or-null-content');
      continue;
    }
    for (const [rule, pattern] of rules) {
      // Lockfile third-party metadata is audited for licenses separately.
      if (rule === 'real-email-address' && normalized === 'package-lock.json') continue;
      if (pattern.test(source)) violations.push(normalized + ': ' + rule);
    }
    const lower = source.toLowerCase();
    if (privateTerms.some(term => lower.includes(term))) {
      violations.push(normalized + ': private-review-term');
    }
  }
  if (violations.length) {
    console.error('PRIVACY_GATE_FAIL: ' + violations.length + ' findings (matched values suppressed)');
    for (const item of violations) console.error(' - ' + item);
    process.exitCode = 1;
  } else {
    console.log('PRIVACY_GATE_PASS: ' + paths.length + ' candidate paths; '
      + (privateTerms.length ? 'generic + private denylist' : 'generic patterns only')
      + '. Independent visual and legal review is still required.');
  }
} catch {
  // Do not echo parse/read error details, which could include a sensitive private path.
  console.error('PRIVACY_GATE_FAIL: Git inventory or private blocklist configuration unavailable');
  process.exitCode = 2;
}

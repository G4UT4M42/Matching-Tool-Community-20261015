import { createHash, randomBytes } from 'crypto';

function hexHash(...parts: (string | number | undefined | null)[]): string {
  const hash = createHash('sha256');
  for (const p of parts) {
    hash.update(String(p ?? ''));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function scanId(fileHash: string, filename: string): string {
  return 'SCAN-' + hexHash(fileHash, filename);
}

export function templateId(vendorName: string, vendorVatId?: string, layoutFingerprint?: string): string {
  return 'TMPL-' + hexHash(vendorName, vendorVatId, layoutFingerprint);
}

export function editId(): string {
  return 'EDIT-' + randomBytes(8).toString('hex');
}

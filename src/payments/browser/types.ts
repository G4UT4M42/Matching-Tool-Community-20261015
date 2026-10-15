import type { FixedDebtor } from '../types.js';

export const GEORGE_USER_NUMBER = '402985692' as const;

export type AutomationPhase =
  | 'queued'
  | 'connecting_browser'
  | 'waiting_login_2fa'
  | 'uploading'
  | 'upload_attempted'
  | 'verifying_import'
  | 'prepared'
  | 'requesting_release'
  | 'release_click_claimed'
  | 'waiting_release_2fa'
  | 'verifying_release'
  | 'released'
  | 'failed'
  | 'unknown';

export interface ObservedAccount {
  accountLabel: string;
  iban: string;
}

/** Immutable local identity. The hash is intentionally never expected from George. */
export interface PackageIdentity {
  artifactSha256: string;
  messageId: string;
  importFilename: string;
  expectedAccount: FixedDebtor;
  itemCount: number;
  controlSumMinor: number;
}

export type ObservedPackageStatus = 'prepared' | 'waiting_release_2fa' | 'released' | 'rejected' | 'unknown';

export type GeorgeUrlClass = 'login' | 'overview' | 'data_import' | 'package_list' | 'package_detail' | 'release_pending';

export interface ReleaseConfirmation {
  debtorIban: string;
  itemCount: number;
  controlSumMinor: number;
  xmlSha256: string;
}

/** Evidence available from the real portal UI; no fictitious portal hash field. */
export interface ObservedPackage {
  reference: string;
  importFilename: string;
  account: ObservedAccount;
  itemCount: number;
  controlSumMinor: number;
  messageId: string;
  warnings: string[];
  status: ObservedPackageStatus;
}

export interface GeorgePageDriver {
  getVerifiedUrlClass(): Promise<GeorgeUrlClass>;
  ensureAuthenticated(userNumber: typeof GEORGE_USER_NUMBER): Promise<'authenticated' | 'waiting_login_2fa'>;
  verifySourceAccount(expected: FixedDebtor): Promise<ObservedAccount>;
  ensureDataImportAvailable(): Promise<'available' | 'activation_required'>;
  findPackage(identity: PackageIdentity, xmlPath: string): Promise<ObservedPackage | null>;
  uploadPackage(xmlPath: string, mode: 'single_package', identity: PackageIdentity): Promise<ObservedPackage>;
  openPackage(reference: string, identity?: PackageIdentity): Promise<ObservedPackage>;
  clickReleaseOnce(reference: string): Promise<void>;
  waitForRelease(reference: string, timeoutMs: number): Promise<'released' | 'rejected' | 'timeout'>;
  close(): Promise<void>;
}

export class GeorgeAutomationError extends Error {
  constructor(public readonly code: string, message: string = code) {
    super(message);
    this.name = 'GeorgeAutomationError';
  }
}

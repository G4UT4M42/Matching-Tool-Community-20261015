import type { Browser, ElementHandle, Page } from 'puppeteer-core';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  connectBrowser,
  isBrowserReachable,
  launchVisibleBrowser,
} from '../../invoicebot/openclaw-client.js';
import type { FixedDebtor } from '../types.js';
import {
  GEORGE_USER_NUMBER,
  GeorgeAutomationError,
  type GeorgePageDriver,
  type GeorgeUrlClass,
  type ObservedAccount,
  type ObservedPackage,
  type ObservedPackageStatus,
  type PackageIdentity,
} from './types.js';
import { notifyGeorgeAuthRequired } from './george-auth-prompt.js';

const GEORGE_URL = 'https://george.sparkasse.at/r/index.html?at=c#/overview';
const APP_ORIGIN = 'https://george.sparkasse.at';
const LOGIN_ORIGIN = 'https://login.sparkasse.at';
const LOGIN_LABELS = [
  'Verfügernummer/Benutzername',
  'Verfügernummer',
  'Benutzernummer',
  'User number/Username',
  'User number',
] as const;
const LOGIN_NEXT_LABELS = ['Login starten', 'Weiter', 'Start login', 'Continue'] as const;
const DATA_IMPORT_LABELS = ['Datenimport', 'Daten Import', 'Daten Import/Export'] as const;
const UPLOAD_LABELS = ['Zahlungsdatei auswählen', 'Zahlungsdatei hochladen', 'Select payment file'] as const;
const RELEASE_LABELS = ['Sammelfreigabe anfordern', 'Paket freigeben', 'Release package'] as const;

function attr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function ariaSelectors(labels: readonly string[], tag = ''): string[] {
  return labels.map(label => `${tag}[aria-label="${attr(label)}"]`);
}

function layout(detail: string): never {
  throw new GeorgeAutomationError('PORTAL_LAYOUT_CHANGED', `PORTAL_LAYOUT_CHANGED: ${detail}`);
}

function isGeorgeAppShell(url: URL): boolean {
  return (url.pathname === '/index.html' && url.search === '')
    || (url.pathname === '/' && url.search === '?at=c');
}

async function firstHandle(page: Page, selectors: readonly string[]): Promise<ElementHandle<any> | null> {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) return handle as ElementHandle<any>;
  }
  return null;
}

async function firstSelector(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) if (await page.$(selector)) return selector;
  return null;
}

async function exactText(page: Page, selectors: readonly string[], detail: string): Promise<string> {
  const handle = await firstHandle(page, selectors);
  if (!handle) layout(detail);
  const value = await handle.evaluate(element => (element.textContent ?? '').trim());
  if (!value) layout(`${detail}: empty`);
  return value;
}

function parseInteger(value: string, detail: string): number {
  const normalized = value.replace(/[^0-9-]/g, '');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) layout(detail);
  return parsed;
}

function parseMoneyMinor(value: string): number {
  const normalized = value.replace(/\s/g, '').replace(/EUR/gi, '').replace(/\./g, '').replace(',', '.');
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) layout('control sum');
  const minor = Math.round(amount * 100);
  if (!Number.isSafeInteger(minor)) layout('control sum');
  return minor;
}

function statusFromEvidence(value: string, semanticStatus: string | null): ObservedPackageStatus {
  const status = value.trim().toLowerCase();
  if (['vorbereitet', 'prepared', 'offen'].includes(status)) return 'prepared';
  if (['freigabe ausstehend', 'waiting for approval', '2fa ausstehend'].includes(status)) return 'waiting_release_2fa';
  if (['freigegeben', 'released', 'signiert', 'signed'].includes(status)) return 'released';
  if (semanticStatus === 'release_rejected' || ['freigabe abgelehnt', 'release rejected'].includes(status)) return 'rejected';
  return 'unknown';
}

interface GeorgeDataCarrierOrder {
  amount?: { value?: number; precision?: number; currency?: string };
  receiver?: { iban?: string };
}

interface GeorgeDataCarrier {
  id?: string;
  identification?: string;
  sumAmount?: { value?: number; precision?: number; currency?: string };
  orderCount?: number;
  state?: string;
  stateDetail?: string;
  flags?: string[];
  bulks?: Array<{
    sender?: { iban?: string };
    orderCount?: number;
    bulkAmount?: { value?: number; precision?: number; currency?: string };
    orders?: GeorgeDataCarrierOrder[];
  }>;
}

interface LocalPaymentEvidence {
  debtorIban: string;
  payments: Array<{ iban: string; amountMinor: number }>;
}

function moneyTextToMinor(value: string): number {
  if (!/^\d+\.\d{2}$/.test(value)) layout('local payment amount');
  const [units, cents] = value.split('.');
  const minor = Number(units) * 100 + Number(cents);
  if (!Number.isSafeInteger(minor)) layout('local payment amount');
  return minor;
}

async function localPaymentEvidence(xmlPath: string): Promise<LocalPaymentEvidence> {
  const xml = await readFile(xmlPath, 'utf8');
  const debtorIban = xml.match(/<DbtrAcct>[\s\S]*?<IBAN>([A-Z]{2}\d+)<\/IBAN>[\s\S]*?<\/DbtrAcct>/)?.[1] ?? '';
  const payments = [...xml.matchAll(/<CdtTrfTxInf>([\s\S]*?)<\/CdtTrfTxInf>/g)].map(match => {
    const block = match[1];
    const amount = block.match(/<InstdAmt\s+Ccy="EUR">(\d+\.\d{2})<\/InstdAmt>/)?.[1] ?? '';
    const iban = block.match(/<CdtrAcct>[\s\S]*?<IBAN>([A-Z]{2}\d+)<\/IBAN>[\s\S]*?<\/CdtrAcct>/)?.[1] ?? '';
    if (!iban) layout('local creditor IBAN');
    return { iban, amountMinor: moneyTextToMinor(amount) };
  });
  if (!debtorIban || payments.length === 0) layout('local payment evidence');
  return { debtorIban, payments };
}

function paymentKey(payment: { iban: string; amountMinor: number }): string {
  return `${payment.iban.replace(/\s/g, '').toUpperCase()}:${payment.amountMinor}`;
}

function exactPortalPackage(
  carrier: GeorgeDataCarrier,
  expected: PackageIdentity,
  local: LocalPaymentEvidence,
): boolean {
  const bulk = carrier.bulks?.length === 1 ? carrier.bulks[0] : null;
  if (!bulk || !Array.isArray(bulk.orders)) return false;
  const portalPayments = bulk.orders.map(order => ({
    iban: order.receiver?.iban ?? '',
    amountMinor: order.amount?.precision === 2 ? Number(order.amount.value) : Number.NaN,
  }));
  return carrier.orderCount === expected.itemCount
    && carrier.sumAmount?.precision === 2
    && carrier.sumAmount?.currency === 'EUR'
    && carrier.sumAmount.value === expected.controlSumMinor
    && bulk.orderCount === expected.itemCount
    && bulk.bulkAmount?.value === expected.controlSumMinor
    && bulk.sender?.iban?.replace(/\s/g, '').toUpperCase() === local.debtorIban
    && portalPayments.map(paymentKey).sort().join('|') === local.payments.map(paymentKey).sort().join('|');
}

function portalStatus(carrier: GeorgeDataCarrier): ObservedPackageStatus {
  const state = `${carrier.state ?? ''}:${carrier.stateDetail ?? ''}`.toUpperCase();
  if (/REJECT|CANCEL|DELETE/.test(state)) return 'rejected';
  if (/SIGNING|WAITING|PENDING|:SIP$/.test(state)) return 'waiting_release_2fa';
  if (/SIGNED|RELEASED|COMPLETED|DONE|CLOSED/.test(state)) return 'released';
  if (carrier.state === 'OPEN' && carrier.flags?.includes('signable')) return 'prepared';
  return 'unknown';
}

async function packageStatus(page: Page): Promise<ObservedPackageStatus> {
  const handle = await firstHandle(page, ['[data-testid="package-status"]']);
  if (!handle) layout('package status');
  const evidence = await handle.evaluate(element => ({
    text: (element.textContent ?? '').trim(),
    semanticStatus: element.getAttribute('data-status'),
  }));
  if (!evidence.text && evidence.semanticStatus !== 'release_rejected') layout('package status: empty');
  return statusFromEvidence(evidence.text, evidence.semanticStatus);
}

async function visibleVerificationCode(page: Page): Promise<string | null> {
  const text = await page.evaluate(() => (globalThis as any).document?.body?.innerText ?? '').catch(() => '');
  return text.match(/(?:Referenzcode|Verifizierungs(?:code|nummer)|Verification code)\s*:?\s*([A-Z0-9]{4,12})/i)?.[1]?.toUpperCase() ?? null;
}

export class PuppeteerGeorgePageDriver implements GeorgePageDriver {
  private keepPageOpen = false;
  private readonly identitiesByReference = new Map<string, PackageIdentity>();
  private readonly summariesByReference = new Map<string, GeorgeDataCarrier>();

  constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly ownsPage = true,
  ) {}

  async getVerifiedUrlClass(): Promise<GeorgeUrlClass> {
    let url: URL;
    try { url = new URL(this.page.url()); } catch { layout('invalid portal URL'); }
    if (url.origin === LOGIN_ORIGIN) {
      if (url.pathname !== '/sts/oauth/authorize' || url.hash !== '') layout('unexpected login route');
      if (!await firstHandle(this.page, [...ariaSelectors(LOGIN_LABELS, 'input'), '[aria-label="Login bestätigen"], [aria-label="Approve login"]'])) {
        layout('login semantic anchor');
      }
      return 'login';
    }
    const plainHash = /^#\/[A-Za-z0-9_/-]+$/.test(url.hash);
    const exactSigningHash = /^#\/datacarrier\/upload\/sign\/[A-Za-z0-9_-]+\?returnUrl=%2Fdatacarrier%2FdataCarrierList$/.test(url.hash);
    if (url.origin !== APP_ORIGIN || !isGeorgeAppShell(url) || (!plainHash && !exactSigningHash)) {
      layout('unexpected portal URL tuple');
    }
    const route = url.hash.slice(1);
    const routeMatches: Record<GeorgeUrlClass, RegExp> = {
      login: /$a/,
      overview: /^\/overview$/,
      data_import: /^\/datacarrier\/upload$/,
      package_list: /^\/datacarrier\/dataCarrierList$/,
      package_detail: /^\/datacarrier\/(?:dataCarrierList\/)?[A-Za-z0-9_-]+$/,
      release_pending: /^\/datacarrier\/(?:(?:dataCarrierList\/)?[A-Za-z0-9_-]+\/(?:sign|release)|upload\/sign\/[A-Za-z0-9_-]+(?:\?returnUrl=%2Fdatacarrier%2FdataCarrierList)?)$/,
    };
    const tuples: Array<[Exclude<GeorgeUrlClass, 'login'>, string]> = [
      ['overview', '[data-cy="main-navigation"], header[aria-label="Hauptnavigation"], [data-testid="account-overview"], [aria-label="Kontenübersicht"], [aria-label="Account overview"]'],
      ['data_import', '[data-cy="upload-file-input"] input[type="file"], input[data-cy="upload-file-input"], input[type="file"]'],
      ['package_list', '[data-cy="package-list-item"], [data-cy="data-carrier-list"], [data-cy^="datacarrier-row-"], [data-cy="async-processing-uploads"], [data-cy="empty-overview"]'],
      ['package_detail', '[data-cy="data-carrier-info-list"], [data-cy="bundle-info-list"], [data-cy="datacarrier-detail"]'],
      ['release_pending', '[data-cy="confirm-sign"], [data-cy="successful-sign"], [data-cy="datacarrier-sign-detail"], [data-cy="error-confirmation-btn"], [data-testid="release-pending"]'],
    ];
    for (const [urlClass, anchor] of tuples) {
      if (routeMatches[urlClass].test(route)) {
        if (!await this.page.$(anchor)) layout(`route-anchor mismatch: ${urlClass}`);
        return urlClass;
      }
    }
    layout('unknown portal route');
  }

  async ensureAuthenticated(userNumber: typeof GEORGE_USER_NUMBER): Promise<'authenticated' | 'waiting_login_2fa'> {
    if (userNumber !== GEORGE_USER_NUMBER) throw new GeorgeAutomationError('GEORGE_USER_NUMBER_NOT_ALLOWED');
    const initialClass = await this.getVerifiedUrlClass();
    const overviewAnchor = '[data-cy="main-navigation"], header[aria-label="Hauptnavigation"], [data-testid="account-overview"], [aria-label="Kontenübersicht"], [aria-label="Account overview"]';
    if (await this.page.$(overviewAnchor)) {
      if (initialClass !== 'overview') layout('authenticated route class');
      return 'authenticated';
    }
    if (initialClass !== 'login') return 'authenticated';
    const loginSelector = await firstSelector(this.page, ariaSelectors(LOGIN_LABELS, 'input'));
    if (!loginSelector) layout('neither account overview nor login field');
    const current = await this.page.$eval(loginSelector, element => (element as any).value);
    if (current !== userNumber) {
      await this.page.focus(loginSelector);
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('KeyA');
      await this.page.keyboard.up('Control');
      await this.page.type(loginSelector, userNumber);
      const asserted = await this.page.$eval(loginSelector, element => (element as any).value);
      if (asserted !== userNumber) layout('user number field did not retain exact value');
    }
    const next = await firstSelector(this.page, [
      ...ariaSelectors(LOGIN_NEXT_LABELS, 'button'),
      ...LOGIN_NEXT_LABELS.map(label => `input[type="submit"][value="${attr(label)}"]`),
    ]);
    if (!next) {
      const disabled = await this.page.$eval(loginSelector, element => (element as any).disabled).catch(() => false);
      if (!disabled) layout('login continue control');
      this.keepPageOpen = true;
      notifyGeorgeAuthRequired('login', await visibleVerificationCode(this.page));
      return 'waiting_login_2fa';
    }
    await this.page.locator(next).click();
    await this.page.waitForSelector(overviewAnchor, { timeout: 1_500 }).catch(() => null);
    if (await this.page.$(overviewAnchor)) {
      if (await this.getVerifiedUrlClass() !== 'overview') layout('post-auth route');
      return 'authenticated';
    }
    this.keepPageOpen = true;
    notifyGeorgeAuthRequired('login', await visibleVerificationCode(this.page));
    return 'waiting_login_2fa';
  }

  async verifySourceAccount(_expected: FixedDebtor): Promise<ObservedAccount> {
    if (await this.getVerifiedUrlClass() !== 'overview') layout('source account route');
    await this.page.waitForSelector('[data-cy="overview-card-title"]', { timeout: 10_000 }).catch(() => null);
    const cards = await this.page.$$('[data-cy="overview-card-title"]');
    for (const title of cards) {
      const observed = await title.evaluate((element, expected) => {
        if ((element.textContent ?? '').trim() !== expected.accountLabel) return null;
        const container = element.closest('.g-card-overview-info-data');
        const text = (container?.textContent ?? '').replace(/\s/g, '');
        const iban = text.match(/AT\d{18}/)?.[0] ?? null;
        return iban ? { accountLabel: expected.accountLabel, iban } : null;
      }, _expected);
      if (observed) return observed;
    }
    const accountsResponse = this.page.waitForResponse(response =>
      response.url() === 'https://api.sparkasse.at/proxy/g/api/my/accounts' && response.status() === 200,
    { timeout: 10_000 }).catch(() => null);
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    const response = await accountsResponse;
    if (response) {
      const body = await response.json().catch(() => null) as {
        collection?: Array<{ alias?: string; description?: string; accountno?: { iban?: string } | null }>;
      } | null;
      const account = body?.collection?.find(candidate =>
        candidate.alias === _expected.accountLabel
        && candidate.description === _expected.accountHolder
        && candidate.accountno?.iban === _expected.iban);
      if (account?.accountno?.iban) {
        await this.page.waitForSelector('[data-cy="main-navigation"], header[aria-label="Hauptnavigation"]', { timeout: 10_000 }).catch(() => null);
        return { accountLabel: account.alias!, iban: account.accountno.iban };
      }
    }
    const accountLabel = await exactText(this.page, [
      '[data-testid="source-account-label"]',
      '[aria-label="Kontoname"]',
      '[aria-label="Account name"]',
    ], 'source account label');
    const iban = (await exactText(this.page, [
      '[data-testid="source-account-iban"]',
      '[aria-label="IBAN des Auftraggeberkontos"]',
      '[aria-label="Source account IBAN"]',
    ], 'source account IBAN')).replace(/\s/g, '').toUpperCase();
    return { accountLabel, iban };
  }

  async ensureDataImportAvailable(): Promise<'available' | 'activation_required'> {
    if (await this.getVerifiedUrlClass() !== 'overview') layout('data import entry route');
    if (await this.page.$('[data-testid="data-import-activation"], [aria-label="Datenimport aktivieren"], [aria-label="Activate data import"]')) {
      return 'activation_required';
    }
    let settings = this.page.waitForResponse(response => response.url().includes('/accounts/datacarriers/settings'), { timeout: 10_000 }).catch(() => null);
    await this.page.evaluate(() => { (globalThis as any).location.hash = '#/datacarrier/upload'; });
    let settingsResponse = await settings;
    if (!settingsResponse) {
      settings = this.page.waitForResponse(response => response.url().includes('/accounts/datacarriers/settings'), { timeout: 10_000 }).catch(() => null);
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      settingsResponse = await settings;
    }
    if (settingsResponse?.status() === 422) {
      const body = await settingsResponse.json().catch(() => null) as { errors?: Array<{ error?: string }> } | null;
      if (body?.errors?.some(error => error.error === 'DATACARRIER_SERVICE_NOT_ACTIVATED')) return 'activation_required';
      layout('data import settings rejected');
    }
    await this.page.waitForSelector([
      ...ariaSelectors(UPLOAD_LABELS, 'input[type="file"]'),
      '[data-cy="upload-file-input"] input[type="file"]',
      'input[data-cy="upload-file-input"]',
      'input[type="file"]',
      '[data-testid="payment-file-upload"]',
      '[data-testid="data-import-activation"]',
    ].join(', '), { timeout: 10_000 }).catch(() => null);
    if (await this.page.$('[data-testid="data-import-activation"], [aria-label="Datenimport aktivieren"], [aria-label="Activate data import"]')) {
      return 'activation_required';
    }
    if (!await firstHandle(this.page, [
      ...ariaSelectors(UPLOAD_LABELS, 'input[type="file"]'),
      '[data-cy="upload-file-input"] input[type="file"]',
      'input[data-cy="upload-file-input"]',
      'input[type="file"]',
      '[data-testid="payment-file-upload"]',
    ])) {
      layout('payment file upload after opening data import');
    }
    if (await this.getVerifiedUrlClass() !== 'data_import') layout('data import route');
    return 'available';
  }

  private async listDataCarriers(): Promise<GeorgeDataCarrier[]> {
    const current = await this.getVerifiedUrlClass();
    if (!['overview', 'data_import', 'package_list', 'release_pending'].includes(current)) layout('package search route');
    const response = this.page.waitForResponse(candidate =>
      candidate.status() === 200 && /\/my\/orders\/datacarriers\?/.test(candidate.url()),
    { timeout: 15_000 }).catch(() => null);
    if (current === 'package_list') await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    else await this.page.evaluate(() => { (globalThis as any).location.hash = '#/datacarrier/dataCarrierList'; });
    const resolved = await response;
    if (!resolved) layout('data carrier list response');
    const body = await resolved.json().catch(() => null) as { dataCarriers?: GeorgeDataCarrier[] } | null;
    if (!Array.isArray(body?.dataCarriers)) layout('data carrier list payload');
    for (const carrier of body.dataCarriers) if (carrier.id) this.summariesByReference.set(carrier.id, carrier);
    await this.page.waitForSelector('[data-cy="data-carrier-list"], [data-cy="empty-overview"]', { timeout: 10_000 }).catch(() => null);
    if (await this.getVerifiedUrlClass() !== 'package_list') layout('package list route');
    return body.dataCarriers;
  }

  private async dataCarrierDetail(reference: string): Promise<GeorgeDataCarrier> {
    if (await this.getVerifiedUrlClass() !== 'package_list') layout('package detail list route');
    const rowSelector = `[data-cy="datacarrier-row-${attr(reference)}"]`;
    const row = await this.page.$(rowSelector);
    if (!row) layout('exact data carrier row');
    const toggle = `${rowSelector} button.g-button-collapsible`;
    if (!await this.page.$(toggle)) layout('data carrier expand control');
    const expanded = await this.page.$eval(toggle, element => element.getAttribute('aria-expanded') === 'true');
    if (expanded) {
      await this.page.$eval(toggle, element => (element as any).click());
      await this.page.waitForFunction(selector =>
        (globalThis as any).document.querySelector(selector)?.getAttribute('aria-expanded') === 'false',
      { timeout: 5_000 }, toggle).catch(() => null);
      const collapsed = await this.page.$eval(toggle, element => element.getAttribute('aria-expanded') === 'false');
      if (!collapsed) layout('data carrier collapse state');
    }
    const response = this.page.waitForResponse(candidate =>
      candidate.status() === 200 && candidate.url().endsWith(`/my/orders/datacarriers/${reference}`),
    { timeout: 15_000 }).catch(() => null);
    await this.page.$eval(toggle, element => (element as any).click());
    const resolved = await response;
    if (!resolved) {
      const cached = this.summariesByReference.get(reference);
      if (cached && this.identitiesByReference.has(reference)) return cached;
      layout('data carrier detail response');
    }
    const body = await resolved.json().catch(() => null) as GeorgeDataCarrier | null;
    if (!body || body.id !== reference) layout('data carrier detail payload');
    return body;
  }

  async findPackage(identity: PackageIdentity, xmlPath: string): Promise<ObservedPackage | null> {
    const local = await localPaymentEvidence(xmlPath);
    const summaries = await this.listDataCarriers();
    const candidates = summaries.filter(carrier => carrier.id
      && carrier.orderCount === identity.itemCount
      && carrier.sumAmount?.precision === 2
      && carrier.sumAmount?.currency === 'EUR'
      && carrier.sumAmount.value === identity.controlSumMinor);
    const matches: GeorgeDataCarrier[] = [];
    for (const candidate of candidates) {
      const detail = await this.dataCarrierDetail(candidate.id!);
      if (exactPortalPackage(detail, identity, local)) matches.push(detail);
    }
    if (matches.length > 1) throw new GeorgeAutomationError('PACKAGE_RECOVERY_AMBIGUOUS');
    if (matches.length === 0) return null;
    const reference = matches[0].id!;
    this.identitiesByReference.set(reference, identity);
    return this.observedPackage(matches[0], identity);
  }

  async uploadPackage(xmlPath: string, mode: 'single_package', identity: PackageIdentity): Promise<ObservedPackage> {
    if (mode !== 'single_package') throw new GeorgeAutomationError('GEORGE_PACKAGE_MODE_REQUIRED');
    if (await this.getVerifiedUrlClass() !== 'data_import') layout('package upload route');
    const upload = await firstHandle(this.page, [
      ...ariaSelectors(UPLOAD_LABELS, 'input[type="file"]'),
      '[data-cy="upload-file-input"] input[type="file"]',
      'input[data-cy="upload-file-input"]',
      '[data-testid="payment-file-upload"]',
    ]) as ElementHandle<any> | null;
    if (!upload) layout('payment file upload');
    await upload.uploadFile(xmlPath);
    await this.page.waitForSelector('[data-cy="default-file-name"]', { timeout: 10_000 }).catch(() => null);
    const selectedFilename = await exactText(this.page, ['[data-cy="default-file-name"]'], 'selected import filename');
    if (!selectedFilename.includes(basename(xmlPath))) layout('selected import filename assertion');
    const packageValue = await this.page.$eval('input[type="hidden"]', element => (element as any).value).catch(() => '');
    const packageButton = await this.page.$eval('[data-cy="import-type-select"]', element => (element.textContent ?? '').trim()).catch(() => '');
    if (packageValue !== 'PACKAGE' && !/Auftragspaket|package/i.test(packageButton)) layout('single package mode assertion');
    const submit = await firstSelector(this.page, [
      '[data-cy="import-file-button"]',
      'button[aria-label="Importieren"]',
      'button[aria-label="Import"]',
      'button[data-testid="submit-payment-import"]',
    ]);
    if (!submit) layout('import submit control');
    await this.page.$eval(submit, element => (element as any).click());
    await this.page.waitForSelector('[data-cy="signing-done-btn"], [data-cy="processing-info-alert"]', { timeout: 30_000 }).catch(() => null);
    if (await this.page.$('[data-cy="processing-info-alert"]')) layout('George rejected payment import');
    if (!await this.page.$('[data-cy="signing-done-btn"]')) layout('payment import success confirmation');

    const observed = await this.findPackage(identity, xmlPath);
    if (!observed) layout('uploaded package readback');
    return observed;
  }

  private observedPackage(carrier: GeorgeDataCarrier, identity: PackageIdentity): ObservedPackage {
    if (!carrier.id) layout('data carrier reference');
    return {
      reference: carrier.id,
      importFilename: identity.importFilename,
      account: { accountLabel: identity.expectedAccount.accountLabel, iban: identity.expectedAccount.iban },
      itemCount: Number(carrier.orderCount),
      controlSumMinor: Number(carrier.sumAmount?.value),
      messageId: identity.messageId,
      warnings: [],
      status: portalStatus(carrier),
    };
  }

  async openPackage(reference: string, identity?: PackageIdentity): Promise<ObservedPackage> {
    const expected = identity ?? this.identitiesByReference.get(reference);
    if (!expected) {
      const initialClass = await this.getVerifiedUrlClass();
      if (!['package_detail', 'release_pending'].includes(initialClass)) layout('package identity for readback');
      const packageReference = await exactText(this.page, ['[data-testid="package-reference"]'], 'package reference');
      if (packageReference !== reference) layout('package reference assertion');
      const account: ObservedAccount = {
        accountLabel: await exactText(this.page, ['[data-testid="package-account-label"]'], 'package account label'),
        iban: (await exactText(this.page, ['[data-testid="package-account-iban"]'], 'package account IBAN')).replace(/\s/g, '').toUpperCase(),
      };
      const itemCount = parseInteger(await exactText(this.page, ['[data-testid="package-item-count"]'], 'package item count'), 'package item count');
      const controlSumMinor = parseMoneyMinor(await exactText(this.page, ['[data-testid="package-control-sum"]'], 'package control sum'));
      const importFilename = await exactText(this.page, ['[data-testid="import-filename"]', '[data-testid="package-import-filename"]'], 'import filename');
      const messageId = await exactText(this.page, ['[data-testid="package-message-id"]'], 'package message ID');
      const status = await packageStatus(this.page);
      const warnings = await this.page.$$eval('[data-testid="package-warning"]', elements => elements.map(element => (element.textContent ?? '').trim()).filter(Boolean));
      return { reference: packageReference, importFilename, account, itemCount, controlSumMinor, messageId, warnings, status };
    }
    this.identitiesByReference.set(reference, expected);
    if (await this.getVerifiedUrlClass() !== 'package_list') {
      const current = await this.getVerifiedUrlClass();
      if (!['overview', 'data_import', 'release_pending'].includes(current)) layout('open package route');
      await this.listDataCarriers();
    }
    const detail = await this.dataCarrierDetail(reference);
    this.identitiesByReference.set(reference, expected);
    return this.observedPackage(detail, expected);
  }

  async clickReleaseOnce(reference: string): Promise<void> {
    const initialClass = await this.getVerifiedUrlClass();
    if (initialClass === 'release_pending') {
      const route = new URL(this.page.url()).hash.slice(1);
      const expectedRoute = `/datacarrier/upload/sign/${reference}?returnUrl=%2Fdatacarrier%2FdataCarrierList`;
      if (route !== expectedRoute || !await this.page.$('[data-cy="confirm-sign"]')) layout('pending release package assertion');
      await this.page.$eval('[data-cy="confirm-sign"]', element => (element as any).click());
      this.keepPageOpen = true;
      notifyGeorgeAuthRequired('release', await visibleVerificationCode(this.page));
      return;
    }
    if (!['package_list', 'package_detail'].includes(initialClass)) layout('release action route');
    let selector: string | null = null;
    if (initialClass === 'package_list') {
      const rowSelector = `[data-cy="datacarrier-row-${attr(reference)}"]`;
      if (!await this.page.$(`${rowSelector} [data-cy="datacarrier-detail"]`)) layout('release package reference assertion');
      selector = await firstSelector(this.page, [`${rowSelector} [data-cy="sign-btn"]`]);
    } else {
      const current = await exactText(this.page, ['[data-testid="package-reference"]'], 'release package reference');
      if (current !== reference) layout('release package reference assertion');
      selector = await firstSelector(this.page, [...ariaSelectors(RELEASE_LABELS, 'button'), '[data-cy="sign-btn"]']);
    }
    if (!selector) layout('release control');
    await this.page.$eval(selector, element => (element as any).click());
    await this.page.waitForSelector('[data-cy="confirm-sign"]', { timeout: 15_000 }).catch(() => null);
    if (!await this.page.$('[data-cy="confirm-sign"]')) layout('release confirmation control');
    if (await this.getVerifiedUrlClass() !== 'release_pending') layout('release confirmation route');
    await this.page.$eval('[data-cy="confirm-sign"]', element => (element as any).click());
    this.keepPageOpen = true;
    notifyGeorgeAuthRequired('release', await visibleVerificationCode(this.page));
  }

  async waitForRelease(reference: string, timeoutMs: number): Promise<'released' | 'rejected' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.page.$('[data-cy="successful-sign"], [data-cy="success-confirmation-btn"]')) {
        const done = '[data-cy="successful-sign-button"], [data-cy="success-confirmation-btn"]';
        if (await this.page.$(done)) await this.page.$eval(done, element => (element as any).click());
        await this.page.waitForSelector('[data-cy="data-carrier-list"]', { timeout: 15_000 }).catch(() => null);
        if (await this.getVerifiedUrlClass() !== 'package_list') layout('post-release package list route');
        const observed = await this.openPackage(reference);
        return observed.status === 'released' ? 'released' : 'timeout';
      }
      if (await this.page.$('[data-cy="error-confirmation-btn"]')) return 'rejected';
      await new Promise(resolve => setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))));
    }
    return 'timeout';
  }

  async close(): Promise<void> {
    if (this.ownsPage && !this.keepPageOpen) await this.page.close().catch(() => undefined);
    this.browser.disconnect();
  }
}

export async function createGeorgePageDriver(): Promise<GeorgePageDriver> {
  if (!await isBrowserReachable()) {
    const launched = await launchVisibleBrowser();
    if (!['launched', 'already_running'].includes(launched.status)) {
      throw new GeorgeAutomationError('BROWSER_CONNECTION', launched.message);
    }
  }
  const browser = await connectBrowser();
  let page: Page | null = null;
  let ownsPage = false;
  try {
    page = (await browser.pages()).find(candidate => {
      try {
        const url = new URL(candidate.url());
        return url.origin === APP_ORIGIN && isGeorgeAppShell(url);
      } catch { return false; }
    }) ?? null;
    if (page && !/^#\/datacarrier\/upload\/sign\/[A-Za-z0-9_-]+\?returnUrl=%2Fdatacarrier%2FdataCarrierList$/.test(new URL(page.url()).hash)) {
      await page.evaluate(() => { (globalThis as any).location.hash = '#/overview'; });
      await page.waitForFunction(() => (globalThis as any).location.hash === '#/overview', { timeout: 10_000 }).catch(() => null);
      await page.waitForSelector('[data-cy="main-navigation"], [data-cy="overview-card-title"]', { timeout: 15_000 }).catch(() => null);
    } else if (!page) {
      page = await browser.newPage();
      ownsPage = true;
      await page.goto(GEORGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    // The public George entry point initially stays on `/` while its bootstrap
    // script resolves the SSO destination. Classifying that transient URL would
    // incorrectly report a layout change before the login page is rendered.
    await page.waitForFunction((appOrigin, loginOrigin) => {
      const url = new URL((globalThis as any).location.href);
      return (url.origin === loginOrigin && url.pathname === '/sts/oauth/authorize')
        || (url.origin === appOrigin
          && ((url.pathname === '/index.html' && url.search === '')
            || (url.pathname === '/' && url.search === '?at=c'))
          && url.hash.startsWith('#/'));
    }, { timeout: 15_000 }, APP_ORIGIN, LOGIN_ORIGIN).catch(() => null);
    await page.waitForSelector([
      ...ariaSelectors(LOGIN_LABELS, 'input'),
      '[aria-label="Login bestätigen"]',
      '[aria-label="Approve login"]',
      '[data-testid="account-overview"]',
      '[data-cy="main-navigation"]',
      '[aria-label="Kontenübersicht"]',
      '[aria-label="Account overview"]',
    ].join(', '), { timeout: 15_000 }).catch(() => null);
    const driver = new PuppeteerGeorgePageDriver(browser, page, ownsPage);
    await driver.getVerifiedUrlClass();
    return driver;
  } catch (error) {
    if (page && ownsPage) await page.close().catch(() => undefined);
    browser.disconnect();
    throw error;
  }
}

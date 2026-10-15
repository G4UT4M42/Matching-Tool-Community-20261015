import type { FxInfo } from '../types.js';
import { toMinor } from './amount.js';

/**
 * Parse FX info from Visa "Buchungs-Details" field.
 * Pattern: "MERCHANT inkl. Fremdwährungsentgelt X,XX Kurs Y,YYYYYYY"
 * Example: "OPENAI *CHATGPT SUBSCR inkl. Fremdwährungsentgelt 0,27 Kurs 1,1280315"
 */
export function parseFxFromVisaDescription(description: string): FxInfo | null {
  // Match the pattern: inkl. Fremdwährungsentgelt <fee> Kurs <rate>
  const match = description.match(
    /inkl\.\s*Fremdw[äa]hrungsentgelt\s+(\d+[,.]?\d*)\s+Kurs\s+(\d+[,.]?\d*)/i
  );
  if (!match) return null;

  const fxFee = parseGermanFloat(match[1]);
  const rate = parseGermanFloat(match[2]);

  if (fxFee == null || rate == null || rate === 0) return null;

  return {
    original_amount_minor: 0, // Will be set later based on EUR amount
    original_currency_code: 'USD', // Most FX transactions are USD
    rate,
    rate_source: 'visa_statement',
    fx_fee_minor: toMinor(fxFee),
  };
}

/**
 * Compute USD original amount from EUR billed amount and rate.
 * eur_billed = usd_original / rate + fx_fee
 * Therefore: usd_original = (eur_billed - fx_fee) * rate
 */
export function computeOriginalAmount(eurBilledMinor: number, fxInfo: FxInfo): number {
  const eurBilled = eurBilledMinor / 100;
  const fxFee = (fxInfo.fx_fee_minor ?? 0) / 100;
  const usdOriginal = (eurBilled - fxFee) * fxInfo.rate;
  return toMinor(Math.round(usdOriginal * 100) / 100);
}

/**
 * Check if a Visa amount matches a USD invoice amount within tolerance.
 * The Visa shows EUR, the invoice shows USD.
 */
export function fxAmountsMatch(
  eurAmountMinor: number,
  usdInvoiceMinor: number,
  fxInfo: FxInfo,
  toleranceCents: number = 100, // ±1.00 EUR tolerance for FX
): boolean {
  const expectedEur = Math.abs(usdInvoiceMinor) / fxInfo.rate;
  const expectedEurMinor = toMinor(expectedEur);
  const actualEurMinor = Math.abs(eurAmountMinor);
  return Math.abs(expectedEurMinor - actualEurMinor) <= toleranceCents;
}

function parseGermanFloat(s: string): number | null {
  const normalized = s.replace(',', '.');
  const n = parseFloat(normalized);
  return isNaN(n) ? null : n;
}

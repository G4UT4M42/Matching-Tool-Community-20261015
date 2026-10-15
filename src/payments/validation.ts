import {
  FIXED_DEBTOR,
  type PaymentDraftInput,
  type PaymentValidationIssue,
} from './types.js';

export function normalizeIban(value: string): string {
  return value.replace(/\s/g, '').toUpperCase();
}

function hasMod97Checksum(value: string): boolean {
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const numeric = character >= 'A' ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) && hasMod97Checksum(iban);
}

export const SEPA_IBAN_COUNTRY_CODES = Object.freeze(new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GB', 'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU',
  'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA',
]));

export function isSepaIban(value: string): boolean {
  return SEPA_IBAN_COUNTRY_CODES.has(normalizeIban(value).slice(0, 2));
}

function isValidIso11649(value: string): boolean {
  const reference = normalizeIban(value);
  return /^RF\d{2}[A-Z0-9]{1,21}$/.test(reference) && hasMod97Checksum(reference);
}

function issue(code: string, message: string, field: keyof PaymentDraftInput): PaymentValidationIssue {
  return { code, message, field, severity: 'error' };
}

export function validatePaymentDraft(input: PaymentDraftInput): PaymentValidationIssue[] {
  const issues: PaymentValidationIssue[] = [];
  if (input.currencyCode !== FIXED_DEBTOR.currencyCode) {
    issues.push(issue('CURRENCY_NOT_EUR', 'Zahlungen sind nur in EUR zulässig.', 'currencyCode'));
  }
  if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor ?? 0) <= 0) {
    issues.push(issue('AMOUNT_NOT_POSITIVE', 'Der Zahlungsbetrag muss eine positive Ganzzahl in Cent sein.', 'amountMinor'));
  }
  if (!input.creditorName?.trim()) {
    issues.push(issue('CREDITOR_NAME_REQUIRED', 'Der Name des Zahlungsempfängers fehlt.', 'creditorName'));
  } else if (input.creditorName.length > 140) {
    issues.push(issue('CREDITOR_NAME_TOO_LONG', 'Der Empfängername darf höchstens 140 Zeichen enthalten.', 'creditorName'));
  }
  if (!input.creditorIban?.trim()) {
    issues.push(issue('CREDITOR_IBAN_REQUIRED', 'Die IBAN des Zahlungsempfängers fehlt.', 'creditorIban'));
  } else if (!isValidIban(input.creditorIban)) {
    issues.push(issue('CREDITOR_IBAN_INVALID', 'Die IBAN des Zahlungsempfängers ist ungültig.', 'creditorIban'));
  } else if (!isSepaIban(input.creditorIban)) {
    issues.push(issue('CREDITOR_IBAN_NOT_SEPA', 'Das Empfängerkonto liegt nicht im SEPA-Raum.', 'creditorIban'));
  } else if (normalizeIban(input.creditorIban) === FIXED_DEBTOR.iban) {
    issues.push(issue('DEBTOR_AS_CREDITOR', 'Das Schuldnerkonto darf nicht das Empfängerkonto sein.', 'creditorIban'));
  }

  const hasUnstructured = Boolean(input.remittanceInformation?.trim());
  const hasStructured = Boolean(input.structuredCreditorReference?.trim());
  if (!hasUnstructured && !hasStructured) {
    issues.push(issue('PAYMENT_REFERENCE_REQUIRED', 'Ein Verwendungszweck oder eine Zahlungsreferenz ist erforderlich.', 'remittanceInformation'));
  } else if (hasUnstructured && hasStructured) {
    issues.push(issue('PAYMENT_REFERENCE_EXCLUSIVE', 'Strukturierte und unstrukturierte Referenz schließen einander aus.', 'remittanceInformation'));
  }
  if ((input.remittanceInformation?.length ?? 0) > 140) {
    issues.push(issue('REMITTANCE_TOO_LONG', 'Der Verwendungszweck darf höchstens 140 Zeichen enthalten.', 'remittanceInformation'));
  }
  if ((input.structuredCreditorReference?.length ?? 0) > 35) {
    issues.push(issue('STRUCTURED_REFERENCE_TOO_LONG', 'Die strukturierte Referenz darf höchstens 35 Zeichen enthalten.', 'structuredCreditorReference'));
  } else if (hasStructured && !isValidIso11649(input.structuredCreditorReference!)) {
    issues.push(issue('STRUCTURED_REFERENCE_INVALID', 'Die strukturierte Referenz ist keine gültige ISO-11649-Referenz.', 'structuredCreditorReference'));
  }
  return issues;
}

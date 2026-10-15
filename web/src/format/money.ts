/// <reference lib="es2022.intl" />
/** Exact decimal text for a source value, independent of floating-point division. */
export function minorUnitDecimal(value: number, currency: string): string {
  if (!Number.isSafeInteger(value) || !Intl.supportedValuesOf('currency').includes(currency)) throw new Error('Invalid financial value or currency');
  const digits = new Intl.NumberFormat('en', {style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 4) throw new Error('Unsupported currency precision');
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount, scale = 10n ** BigInt(digits);
  const sign = amount < 0n ? '-' : '';
  const integer = (absolute / scale).toString();
  return digits ? sign + integer + '.' + (absolute % scale).toString().padStart(digits,'0') : sign + integer;
}

/** Locale display only; editable values use the exact plain decimal function above. */
export function formatMinorUnits(value: number, currency: string, locale='en'): string {
  const decimal = minorUnitDecimal(value,currency);
  const [integer,fraction] = decimal.replace(/^-/, '').split('.');
  const whole = new Intl.NumberFormat(locale,{maximumFractionDigits:0,useGrouping:true}).format(BigInt(integer));
  const formatter = new Intl.NumberFormat(locale,{style:'currency',currency});
  return formatter.formatToParts(value < 0 ? -1n : 1n).map(part => {
    if (part.type === 'integer') return whole;
    if (part.type === 'fraction') return fraction ?? '';
    return part.value;
  }).join('');
}

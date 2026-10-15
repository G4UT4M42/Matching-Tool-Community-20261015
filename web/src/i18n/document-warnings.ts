const messages = {
  DOCUMENT_CURRENCY_MISSING_OR_AMBIGUOUS: {en:'Currency is missing or ambiguous',de:'Die Währung fehlt oder ist mehrdeutig.'},
  DOCUMENT_INVOICE_NUMBER_MISSING_OR_AMBIGUOUS: {en:'Invoice number is missing or ambiguous',de:'Die Rechnungsnummer fehlt oder ist mehrdeutig.'},
  DOCUMENT_DATE_MISSING_OR_AMBIGUOUS: {en:'Invoice date is missing or ambiguous',de:'Das Rechnungsdatum fehlt oder ist mehrdeutig.'},
  DOCUMENT_GROSS_MISSING_OR_AMBIGUOUS: {en:'Gross amount is missing or ambiguous',de:'Der Bruttobetrag fehlt oder ist mehrdeutig.'},
  DOCUMENT_NET_OR_VAT_AMBIGUOUS: {en:'Net or VAT amount is ambiguous',de:'Der Netto- oder Umsatzsteuerbetrag ist mehrdeutig.'},
  DOCUMENT_TOTAL_MISMATCH: {en:'Net plus VAT does not equal gross',de:'Nettobetrag und Umsatzsteuer ergeben nicht den Bruttobetrag.'},
  DOCUMENT_RECOGNITION_FAILED: {en:'Recognition failed; review fields manually',de:'Die Erkennung ist fehlgeschlagen. Bitte prüfen Sie die Felder manuell.'},
  OCR_ENGINE_UNAVAILABLE: {en:'The local OCR language resource is unavailable. Review fields manually.',de:'Die lokale OCR-Sprachdatei ist nicht verfügbar. Bitte prüfen Sie die Felder manuell.'},
  OCR_TIMEOUT: {en:'Recognition exceeded the per-page processing limit. Review fields manually.',de:'Die Erkennung hat das Zeitlimit pro Seite überschritten. Bitte prüfen Sie die Felder manuell.'},
  PAGE_LIMIT: {en:'PDF page count exceeds the recognition limit. Review fields manually.',de:'Die PDF-Seitenzahl überschreitet das Erkennungslimit. Bitte prüfen Sie die Felder manuell.'},
  TEXT_LIMIT: {en:'PDF text exceeds its review limit. Review fields manually.',de:'Der PDF-Text überschreitet das Prüfungslimit. Bitte prüfen Sie die Felder manuell.'},
  PIXEL_LIMIT: {en:'Rendered PDF exceeds the OCR pixel budget. Review fields manually.',de:'Die gerenderte PDF-Datei überschreitet das OCR-Pixellimit. Bitte prüfen Sie die Felder manuell.'},
} as const;
type WarningCode=keyof typeof messages;
// Display compatibility only. Persisted recognition and audit bytes stay exact.
const historical:Record<string,WarningCode>={
  'Currency is missing or ambiguous':'DOCUMENT_CURRENCY_MISSING_OR_AMBIGUOUS',
  'Invoice number is missing or ambiguous':'DOCUMENT_INVOICE_NUMBER_MISSING_OR_AMBIGUOUS',
  'Invoice date is missing or ambiguous':'DOCUMENT_DATE_MISSING_OR_AMBIGUOUS',
  'Gross amount is missing or ambiguous':'DOCUMENT_GROSS_MISSING_OR_AMBIGUOUS',
  'Net or VAT amount is ambiguous':'DOCUMENT_NET_OR_VAT_AMBIGUOUS',
  'Net plus VAT does not equal gross':'DOCUMENT_TOTAL_MISMATCH',
  'Recognition failed; review fields manually':'DOCUMENT_RECOGNITION_FAILED',
  'The local OCR language resource is unavailable':'OCR_ENGINE_UNAVAILABLE',
  'Recognition exceeded the per-page processing limit':'OCR_TIMEOUT',
  'PDF page count exceeds the recognition limit':'PAGE_LIMIT',
  'PDF text exceeds its review limit':'TEXT_LIMIT',
  'Combined PDF text exceeds its review limit':'TEXT_LIMIT',
  'Rendered PDF exceeds the OCR pixel budget':'PIXEL_LIMIT',
};
/** Unknown historical/provider warnings are source evidence, shown unchanged. */
export function documentWarningMessage(warning:string,locale:'en'|'de'):string{
  const code=Object.prototype.hasOwnProperty.call(messages,warning)?warning as WarningCode:Object.prototype.hasOwnProperty.call(historical,warning)?historical[warning]:undefined;
  return code?messages[code][locale]:warning;
}

import {describe,expect,it} from 'vitest';
import {parseRecognizedInvoice} from '../src/community/documents/recognition.js';
import {documentWarningMessage} from '../web/src/i18n/document-warnings.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {CommunityDocumentService} from '../src/community/documents/service.js';
import {createEmptyState} from '../src/storage/json-store.js';

describe('stable application guidance with historical display compatibility',()=>{
  it('emits stable missing-field codes without changing recognized source text',()=>{
    const raw='Original invoice evidence <strong>unchanged</strong>';
    const recognized=parseRecognizedInvoice(raw);
    expect(recognized.raw_text).toBe(raw);
    expect(recognized.warnings).toEqual(['DOCUMENT_CURRENCY_MISSING_OR_AMBIGUOUS','DOCUMENT_INVOICE_NUMBER_MISSING_OR_AMBIGUOUS','DOCUMENT_DATE_MISSING_OR_AMBIGUOUS','DOCUMENT_GROSS_MISSING_OR_AMBIGUOUS']);
    expect(recognized.total_amount_minor).toBeUndefined();
  });
  it('retains exact amounts while reporting ambiguous and inconsistent tax values by code',()=>{
    const result=parseRecognizedInvoice('Invoice number: SYN-1\nSupplier: Fictional\nInvoice date: 2026-10-15\nNet total: EUR 10.00\nVAT: EUR 2.00\nGrand total: EUR 13.00');
    expect(result).toMatchObject({invoice_number:'SYN-1',total_amount_minor:1300,net_amount_minor:1000,vat_amount_minor:200});
    expect(result.warnings).toEqual(['DOCUMENT_TOTAL_MISMATCH']);
    expect(parseRecognizedInvoice('Net total: EUR 10.00\nNet total: EUR 11.00\nGrand total: EUR 13.00').warnings).toContain('DOCUMENT_NET_OR_VAT_AMBIGUOUS');
  });
  it('persists a local OCR resource failure as a stable code with original bytes still downloadable',async()=>{
    const root=await mkdtemp(join(tmpdir(),'community-warning-test-'));let state=createEmptyState('SYNTHETIC-WARNING');
    try{
      const principal={subject:'synthetic-owner',workspace_id:'synthetic-workspace'};
      const service=new CommunityDocumentService({root,localLanguageDir:join(root,'missing-language'),getState:()=>state,persistAndActivate:(_before,next)=>{state=next;}});
      const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#fff'}}).png().toBuffer();
      const result=await service.upload(principal,bytes,'synthetic.png');
      expect(result.record.recognition.warnings).toEqual(['OCR_ENGINE_UNAVAILABLE']);
      expect((state.audit_events.at(-1)!.after!.baseline as {recognition:{warnings:string[]}}).recognition.warnings).toEqual(['OCR_ENGINE_UNAVAILABLE']);
      expect((await service.download(principal,result.record.id)).buffer.equals(bytes)).toBe(true);
      expect(state.documents.size).toBe(0);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it.each([
    ['DOCUMENT_CURRENCY_MISSING_OR_AMBIGUOUS','Currency is missing or ambiguous','Die Währung fehlt oder ist mehrdeutig.'],
    ['DOCUMENT_INVOICE_NUMBER_MISSING_OR_AMBIGUOUS','Invoice number is missing or ambiguous','Die Rechnungsnummer fehlt oder ist mehrdeutig.'],
    ['DOCUMENT_DATE_MISSING_OR_AMBIGUOUS','Invoice date is missing or ambiguous','Das Rechnungsdatum fehlt oder ist mehrdeutig.'],
    ['DOCUMENT_GROSS_MISSING_OR_AMBIGUOUS','Gross amount is missing or ambiguous','Der Bruttobetrag fehlt oder ist mehrdeutig.'],
    ['DOCUMENT_NET_OR_VAT_AMBIGUOUS','Net or VAT amount is ambiguous','Der Netto- oder Umsatzsteuerbetrag ist mehrdeutig.'],
    ['DOCUMENT_TOTAL_MISMATCH','Net plus VAT does not equal gross','Nettobetrag und Umsatzsteuer ergeben nicht den Bruttobetrag.'],
    ['DOCUMENT_RECOGNITION_FAILED','Recognition failed; review fields manually','Die Erkennung ist fehlgeschlagen. Bitte prüfen Sie die Felder manuell.'],
  ])('localizes %s and its unchanged historical warning', (code,historical,german)=>{
    expect(documentWarningMessage(code,'en')).toBe(historical);
    expect(documentWarningMessage(code,'de')).toBe(german);
    expect(documentWarningMessage(historical,'de')).toBe(german);
  });
  it.each([
    ['OCR_ENGINE_UNAVAILABLE','The local OCR language resource is unavailable'],
    ['OCR_TIMEOUT','Recognition exceeded the per-page processing limit'],
    ['PAGE_LIMIT','PDF page count exceeds the recognition limit'],
    ['TEXT_LIMIT','PDF text exceeds its review limit'],
    ['TEXT_LIMIT','Combined PDF text exceeds its review limit'],
    ['PIXEL_LIMIT','Rendered PDF exceeds the OCR pixel budget'],
  ])('maps retained recognition-failure guidance %s without modifying stored evidence',(code,historical)=>{
    expect(documentWarningMessage(code,'de')).toBe(documentWarningMessage(historical,'de'));
    expect(documentWarningMessage(code,'de')).not.toBe(code);
    expect(documentWarningMessage(code,'en')).not.toBe(code);
    expect(historical).not.toBe(documentWarningMessage(historical,'de'));
  });
  it.each(['Unrecognized original provider notice <script>unchanged</script>','__proto__','toString','constructor','DOCUMENT_FUTURE_WARNING'])('keeps unknown source warning text exact: %s',warning=>{
    expect(documentWarningMessage(warning,'de')).toBe(warning);
    expect(documentWarningMessage(warning,'en')).toBe(warning);
  });
});

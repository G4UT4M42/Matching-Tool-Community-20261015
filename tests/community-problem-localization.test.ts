import {describe,it,expect} from 'vitest';
import {problemMessage} from '../web/src/i18n/community-problems.js';
describe('localized actionable API problems',()=>{
 it('preserves English evidence and gives German recovery guidance for financial and file failures',()=>{
  const fixtures=[['INVALID_FIELDS','Rechnungsnummer'],['INVALID_DEBTOR','IBAN'],['BANK_CONSENT_REQUIRED','erneuern'],['CONFIRMATION_INVALID','verbraucht'],['STALE_REVISION','neu laden'],['ALLOCATION_CONFLICT','rückgängig'],['MATCHED_EVIDENCE','Zuordnungen'],['FILE_LIMIT','Größe'],['PERSISTENCE_REJECTED','Prüfsumme'],['REAUTHENTICATION_REQUIRED','Passwort']];
  for(const[code,word]of fixtures){expect(problemMessage({code,error:'Specific English explanation'},'en')).toBe('Specific English explanation');const german=problemMessage({code,error:'Specific English explanation'},'de');expect(german).toContain(word);expect(german).toContain(code);expect(german).not.toContain('Specific English');}
 });
 it('uses bounded safe diagnostics for unknown or malformed codes',()=>{
  expect(problemMessage({code:'NEW_PROVIDER_FAILURE',error:'Upstream technical detail'},'de')).toContain('(NEW_PROVIDER_FAILURE)');
  expect(problemMessage({code:'<script>secret</script>',error:'Upstream technical detail'},'de')).not.toContain('script');
  expect(problemMessage(null,'de')).toContain('Berechtigungen');expect(problemMessage({},'en','Try again')).toBe('Try again');
 });
});

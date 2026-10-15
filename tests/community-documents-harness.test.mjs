import test from 'node:test';

test('document component uses actual packaged offline OCR, correction, preview, portal import and verified reopen',{timeout:120000},async()=>{
 await import('./community-documents-browser.mjs');
});

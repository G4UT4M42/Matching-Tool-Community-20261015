/** Standalone synthetic browser qualification. Run: npx tsx tests/community-documents-browser.mjs */
import express from 'express';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';
import { createServer as createViteServer } from 'vite';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CommunityDocumentService } from '../src/community/documents/service.ts';
import { createCommunityDocumentsRouter } from '../src/server/routes/community-documents.ts';
import { InvoiceBotCoordinator } from '../src/community/invoice-bot/coordinator.ts';
import { createCommunityInvoiceBotRouter } from '../src/server/routes/community-invoice-bot.ts';

const evidence = process.env.MATCHING_COMPONENT_BROWSER_EVIDENCE_ROOT ? join(process.env.MATCHING_COMPONENT_BROWSER_EVIDENCE_ROOT,'documents') : await mkdtemp(join(tmpdir(),'matching-documents-evidence-'));
await mkdir(evidence,{recursive:true});
const working = await mkdtemp(join(evidence, 'browser-synthetic-'));
const profile = join(working, 'clean-edge-profile');
await mkdir(profile);
const fixture = join(working, 'synthetic-invoice.png');
const svg = `<svg width="1400" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="Arial" font-size="44" fill="black"><text x="40" y="85">Invoice number: BROWSER-001</text><text x="40" y="160">Supplier: Synthetic Browser Ltd</text><text x="40" y="235">Invoice date: 2026-10-14</text><text x="40" y="310">Net total: EUR 100.00</text><text x="40" y="385">VAT: EUR 20.00</text><text x="40" y="460">Grand total: EUR 120.00</text></g></svg>`;
await writeFile(fixture, await sharp(Buffer.from(svg)).png().toBuffer());
let state = { run_id: 'browser-synthetic', transactions: new Map(), documents: new Map(), match_groups: new Map(), exclusion_rules: [], audit_events: [], matched_transaction_ids: new Set(), matched_document_ids: new Set(), excluded_transaction_ids: new Set() };
const storage = join(working, 'storage');
const makeDocuments = () => new CommunityDocumentService({ root: storage, getState: () => state, persistAndActivate: (expected, next) => { if (expected !== state) throw Error('stale'); state = next; } });
let documents = makeDocuments();
const portal = express();
portal.get('/invoices', (_request, response) => response.json([{ source_id: 'PORTAL-001', filename: 'portal-001.png', href: '/invoice/PORTAL-001' }]));
portal.get('/invoice/PORTAL-001', async (_request, response) => { response.type('png').send(await sharp(Buffer.from(svg.replaceAll('BROWSER-001','PORTAL-001'))).png().toBuffer()); });
const portalServer = portal.listen(0, '127.0.0.1');
await new Promise(resolve => portalServer.once('listening', resolve));
const portalOrigin = `http://127.0.0.1:${portalServer.address().port}`;
let connected = false;
const sessions = { openFreshSession: async () => { connected = true; }, disconnect: async () => { connected = false; }, isConnected: async () => connected };
const adapter = { id: 'local-fixture', label: 'Local fake invoice portal', origin: portalOrigin, connect: async () => {}, discover: async () => (await (await fetch(`${portalOrigin}/invoices`)).json()), download: async (_principal, _session, invoice) => Buffer.from(await (await fetch(new URL(invoice.href, portalOrigin))).arrayBuffer()) };
const bot = new InvoiceBotCoordinator([adapter], sessions, documents, true);
const api = express();
api.use(express.json());
api.use((_request, response, next) => { response.locals.communityPrincipal = { subject: 'browser-owner', workspace_id: 'browser-workspace' }; next(); });
api.use('/api/community/documents', createCommunityDocumentsRouter(documents, () => true));
api.use('/api/community/invoice-bot', createCommunityInvoiceBotRouter(bot, () => true));
const apiServer = api.listen(0, '127.0.0.1');
await new Promise(resolve => apiServer.once('listening', resolve));
const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
const webRoot = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const entry = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { LanguageProvider } from '/src/i18n/locale.tsx'; import { CommunityDocuments } from '/src/pages/CommunityDocuments.tsx'; import { CommunityInvoiceBot } from '/src/pages/CommunityInvoiceBot.tsx'; function App(){ const [tab,setTab]=React.useState('documents'); return <LanguageProvider><nav><button onClick={()=>setTab('documents')}>Documents tab</button><button onClick={()=>setTab('bot')}>Bot tab</button></nav>{tab==='documents'?<CommunityDocuments/>:<CommunityInvoiceBot/>}</LanguageProvider> }; createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createViteServer({ root: webRoot, cacheDir: join(working, 'vite-cache'), plugins: [{ name: 'synthetic-harness', configureServer(server) { server.middlewares.use('/__community.html', async (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__community.html', '<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/__community_entry.tsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__community_entry.tsx') return id; }, load(id) { if (id === '/__community_entry.tsx') return entry; } }], server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': apiOrigin } }, logLevel: 'error' });
await vite.listen();
const webOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
let browser,page;
const errors=[],requests=[],safeErrors=[];
const safeError=(kind,error)=>({kind,name:/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(String(error?.name??''))?error.name:'Error',message_prefix_sha256:createHash('sha256').update(String(error).slice(0,2000)).digest('hex')});
const recordSafeError=(kind,error)=>{if(safeErrors.length<20)safeErrors.push(safeError(kind,error));};
const clickWhenEnabled=async(text,mode='includes',selector='button')=>{
  await page.waitForFunction((text,mode,selector)=>[...document.querySelectorAll(selector)].some(button=>(mode==='exact'?button.textContent===text:button.textContent?.includes(text))&&!button.matches(':disabled')),{},text,mode,selector);
  await page.evaluate((text,mode,selector)=>{
    const button=[...document.querySelectorAll(selector)].find(button=>(mode==='exact'?button.textContent===text:button.textContent?.includes(text))&&!button.matches(':disabled'));
    if(!button)throw new Error('Enabled synthetic button disappeared');
    button.click();
  },text,mode,selector);
};
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', userDataDir: profile, headless: true, args: ['--no-sandbox','--disable-gpu','--disable-extensions','--disable-background-networking'] });
  page = await browser.newPage();
  page.on('pageerror',error=>{errors.push(String(error));recordSafeError('page',error);});
  page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());recordSafeError('console',message.text());}});
  page.on('response',response=>{
    const url=new URL(response.url());
    if(url.origin===webOrigin&&url.pathname.startsWith('/api/')){
      const method=response.request().method();
      requests.push({method:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method)?method:'OTHER',path:url.pathname.slice(0,300),status:response.status()});
      if(requests.length>100)requests.shift();
    }
    if(response.status()>=400)errors.push(response.status()+' '+url.pathname);
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${webOrigin}/__community.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[type=file]');
  await (await page.$('input[accept=".pdf,.png,.jpg,.jpeg"]')).uploadFile(fixture);
  await page.waitForFunction(() => document.body.textContent.includes('synthetic-invoice.png'), { timeout: 30000 });
  await page.screenshot({ path: join(evidence, 'documents-upload-review.png'), fullPage: true });
  await page.getByText?.('synthetic-invoice.png');
  await clickWhenEnabled('synthetic-invoice.png');
  await page.waitForSelector('input[value="BROWSER-001"]');
  assert.equal(await page.$eval('#document-field-total_amount',node=>node.value),'120.00');
  const supplierInput = await page.$('input[value="Synthetic Browser Ltd"]');
  await supplierInput.click();
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await supplierInput.type('Corrected Browser Ltd');
  await clickWhenEnabled('Save corrections');
  await page.waitForFunction(() => [...document.querySelectorAll('dd')].some(item => item.textContent === 'Corrected Browser Ltd'), { timeout: 15000 });
  await clickWhenEnabled('Confirm invoice');
  await page.waitForFunction(() => document.body.textContent.includes('synthetic-invoice.png · confirmed'), { timeout: 15000 });
  await page.screenshot({ path: join(evidence, 'documents-confirmed.png'), fullPage: true });
  await clickWhenEnabled('Preview','exact');
  await page.waitForSelector('img[alt="synthetic-invoice.png"]');
  await page.screenshot({ path: join(evidence, 'documents-preview.png'), fullPage: true });
  await clickWhenEnabled('Bot tab','exact','nav button');
  await page.waitForFunction(() => document.body.textContent.includes('Local fake invoice portal'));
  await clickWhenEnabled('Connect a fresh browser session');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Discover downloaded files')));
  await clickWhenEnabled('Discover downloaded files');
  await page.waitForFunction(() => document.body.textContent.includes('portal-001.png'));
  await page.click('input[type=checkbox]');
  await clickWhenEnabled('Import selected');
  await page.waitForFunction(() => document.body.textContent.includes('imported'));
  await page.screenshot({ path: join(evidence, 'invoice-bot-local-import.png'), fullPage: true });
  documents = makeDocuments();
  await clickWhenEnabled('Documents tab','exact','nav button');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.textContent.includes('synthetic-invoice.png · confirmed'));
  await page.screenshot({ path: join(evidence, 'documents-reopen.png'), fullPage: true });
  assert.equal(state.documents.size,1);assert.equal([...state.documents.values()][0].total_amount_minor,12000);assert.equal([...state.documents.values()][0].supplier_name,'Corrected Browser Ltd');assert.deepEqual(errors,[]);
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify({ status: 'passed', real_packaged_offline_ocr:true, errors, synthetic_only:true, screenshots: ['documents-upload-review.png','documents-confirmed.png','documents-preview.png','invoice-bot-local-import.png','documents-reopen.png'], financial_documents: state.documents.size }, null, 2));
  console.log('Browser scenario passed', { financial_documents: state.documents.size });
} catch(error) {
  let buttons=[],button_capture_ok=false,screenshot_capture_ok=false;
  if(page&&!page.isClosed()){
    try{buttons=await page.evaluate(()=>[...document.querySelectorAll('button')].slice(0,50).map(button=>({label:(button.textContent??'').replace(/\s+/g,' ').trim().slice(0,120),own_disabled:button.disabled,effective_disabled:button.matches(':disabled')})));button_capture_ok=true;}catch{}
    try{await page.screenshot({path:join(evidence,'failure.png'),fullPage:false,type:'png'});screenshot_capture_ok=true;}catch{}
  }
  const failure={result:'FAIL',synthetic_only:true,error:safeError('scenario',error),requests,buttons,error_count:errors.length,errors:safeErrors,button_capture_ok,screenshot_capture_ok};
  try{await writeFile(join(evidence,'failure.json'),JSON.stringify(failure,null,2));}catch{console.error('Synthetic failure evidence could not be written');}
  throw error;
} finally {
  if (browser) await browser.close();
  await vite.close();
  apiServer.close(); portalServer.close();
}

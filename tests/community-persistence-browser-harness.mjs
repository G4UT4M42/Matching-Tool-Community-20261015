import express from 'express';
import { createServer } from 'vite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'community-browser-manual-'));
process.env.MATCHING_RUNTIME_MODE = 'external-runtime-root'; process.env.MATCHING_RUNTIME_ROOT = root;
const store = await import('../src/storage/db.ts'); store.getDb();
mkdirSync(join(root, 'state'));
writeFileSync(join(root, 'state', 'state.json'), JSON.stringify({ schema_version: 1, format: 'matching-community-state-v1', run_id: 'BROWSER-SYNTHETIC', transactions: {}, documents: {}, match_groups: {}, exclusion_rules: [], audit_events: [], matched_transaction_ids: [], matched_document_ids: [], excluded_transaction_ids: [] }));
const { createCommunityPersistenceRouter } = await import('../src/server/routes/community-persistence.ts');
const app = express(); app.use(express.json());
app.use('/api/community/persistence', (_request, response, next) => { response.locals.communityPrincipal = { subject: 'browser-owner' }; next(); }, createCommunityPersistenceRouter({
  activeRuntimeRoot: () => root, withExclusiveAccess: run => run(), may: principal => principal.subject === 'browser-owner', inspectCurrent: () => ({}), invalidateCheckpoint: () => {},
  safeActivate: async (change, rollback) => { store.closeDb(); try { change(); store.getDb(); } catch (error) { rollback(); store.getDb(); throw error; } },
}));
const vite = await createServer({ configFile: false, root: resolve('web'), cacheDir: join(root, 'vite-cache'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
app.get('/persistence-test', async (request, response) => {
  const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {LanguageProvider} from '/src/i18n/locale.tsx'; import {CommunityDataManagement} from '/src/pages/CommunityDataManagement.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(LanguageProvider,null,React.createElement(CommunityDataManagement)));
  </script></body></html>`;
  response.type('html').send(await vite.transformIndexHtml(request.url, html));
});
app.use(vite.middlewares);
const server = app.listen(0, '127.0.0.1', () => {
  console.log(`HARNESS_URL=http://127.0.0.1:${server.address().port}/persistence-test`);
  console.log(`HARNESS_ROOT=${root}`);
});
process.on('SIGINT', async () => { server.close(); await vite.close(); store.closeDb(); rmSync(root, { recursive: true, force: true }); process.exit(0); });

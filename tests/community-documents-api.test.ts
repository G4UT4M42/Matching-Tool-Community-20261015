import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { MatchingState } from '../src/core/types.js';
import { CommunityDocumentService } from '../src/community/documents/service.js';
import { createCommunityDocumentsRouter } from '../src/server/routes/community-documents.js';

describe('Community document HTTP authentication and ownership', () => {
  let root: string, server: Server, url: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'community-doc-api-'));
    let state: MatchingState = { run_id: 'api-test', transactions: new Map(), documents: new Map(), match_groups: new Map(), exclusion_rules: [], audit_events: [], matched_transaction_ids: new Set(), matched_document_ids: new Set(), excluded_transaction_ids: new Set() };
    const documents = new CommunityDocumentService({ root, getState: () => state, persistAndActivate: (_expected, next) => { state = next; } });
    const app = express(); app.use(express.json());
    app.use((request, response, next) => { const account = request.header('x-test-principal'); if (account) response.locals.communityPrincipal = { subject: account, workspace_id: request.header('x-test-workspace') ?? 'workspace-a' }; next(); });
    app.use('/api/community/documents', createCommunityDocumentsRouter(documents, principal => principal.subject !== 'reader-denied'));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/community/documents`;
  });
  afterAll(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  it('rejects missing and denied principals, then scopes preview to workspace', async () => {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { 'x-test-principal': 'reader-denied' } })).status).toBe(403);
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'safe.png');
    const upload = await fetch(`${url}/upload`, { method: 'POST', headers: { 'x-test-principal': 'alice' }, body: form });
    expect(upload.status).toBe(201);
    const record = (await upload.json() as { record: { id: string; hash: string } }).record;
    expect(record.hash).toMatch(/^[a-f0-9]{64}$/);
    const preview = await fetch(`${url}/${record.id}/content`, { headers: { 'x-test-principal': 'alice' } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await preview.arrayBuffer()).equals(png)).toBe(true);
    expect((await fetch(`${url}/${record.id}`, { headers: { 'x-test-principal': 'bob', 'x-test-workspace': 'workspace-b' } })).status).toBe(404);
    expect((await fetch(`${url}/${record.id}/content`)).status).toBe(401);
  }, 30_000);
});

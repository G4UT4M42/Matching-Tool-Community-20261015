# Exact accounting implementation and integration

## Decision and source evidence

This package addresses the matching and reporting gaps identified as F05–F09 in `docs/release-program/FEATURE_PARITY_AUDIT_20261013.md` and the P08/P09 work packages. The existing decision module accepted only complete source records; `json-store.ts` had no allocation representation; the older VAT module contains provider and jurisdiction heuristics. The new report path does not call that older VAT module. It needs reviewed tax classification and document evidence, and it exposes missing classification.

The source `Transaction` and `Document` maps remain immutable evidence. A `CommunityAllocation` links original IDs; it never edits their amounts. Each accepted leg has its own signed transaction amount and, for a document link, signed document amount. Fee and transfer legs have no document amount. Cross-currency legs require positive safe-integer numerator and denominator plus a source and evidence reference; exact equality is checked with `BigInt`. No currency amounts are summed together. Accepted full-record match groups reserve all member balances; accepted allocation legs reserve only their explicit portions. Partial documents are reported as partially matched. The legacy matched-ID sets mean *linked to a proposal or decision*, including partial links; report reconciliation uses remaining balances instead of treating set membership as full settlement.

Proposal IDs are hashes of original transaction/document IDs, signed amount and currency. Reruns leave existing rejected IDs intact. Ambiguous same-amount candidates carry `ambiguous_candidate`; every candidate stays proposed until explicit review. This is intentionally a conservative exact candidate rule, not a claim of supplier, payment-reference or provider-rule parity. The old matching engine remains outside this package and should not be called to recreate accepted/rejected work for this path.

## JSON format and recovery

Historical `matching-community-state-v1` snapshots stay version 1 and load unchanged. The first reviewed accounting action creates the optional `accounting` capability with `capability: exact-accounting-v1`; serialization then writes `schema_version: 2`, `format: matching-community-state-v2`. A v1 header with accounting data or a v2 header without it fails closed. The original atomic fsynced replacement and pending statement-journal guard remain in `json-store.ts`. There is no silent upgrade at load. Backward downgrade must be blocked; older v1 code must not write a v2 snapshot. The supervisor's SQLite/JSON transaction coordinator must retain a consistent prior generation and compare the expected state before activation. `tests/community-accounting.test.ts` covers v1/v2 distinction and corrupt reload; `tests/community-accounting-restart.test.ts` saves a real isolated v2 file, reloads after module reset and proves corrupt bytes are not overwritten; `tests/json-state-migration.test.ts` retains the old v1 regression.

## Explicit classification and report rules

Transactions default to `unclassified`. A trusted authorized action can classify income, expense, fee, refund, transfer or private with evidence. Accepted fee, transfer and refund allocation kinds take precedence in reports. Source events explicitly marked `meta.accounting_event_kind` as `provider_payout` or `internal_transfer` report as transfer and cannot be classified as new revenue. Duplicated recognized source-system/account/row identities fail validation. Exclusions use only bounded literal `contains`, `equals` and `starts_with` over allowlisted fields. An action that would exclude or privatize an accepted allocation fails until the allocation is undone. Original records remain in report rows, labeled `excluded` or `private`.

Document VAT defaults to `unclassified`. A reviewer supplies tax category, rational rate, signed VAT minor units, input eligibility and evidence reference. The exact VAT value belongs to the document; aggregate VAT is the sum of per-document values after reconciliation. `roundRationalHalfAwayFromZero` is available for independently checked per-document arithmetic, but the service does not invent VAT from a jurisdictional default. Incomplete documents do not contribute VAT totals. The report contains per-currency transaction category totals and VAT totals, remaining balances, source IDs, match/allocation IDs, evidence references and audit IDs. CSV uses fixed columns and prefixes spreadsheet formula-like text; exact numeric minor units and currency codes are explicit. JSON contains the same report dataset. An inclusive validated date range selects rows by posting date and documents by document date. This does not establish legal tax advice or live provider qualification.

## Router contract and exact wiring for supervisor-owned files

An explicit `meta.accounting_status: cancelled` source record remains visible, cannot be allocated, and contributes no VAT.

`createCommunityAccountingRouter` in `src/server/routes/community-accounting.ts` accepts:

```ts
{
  workspaceId: string,
  getState: () => MatchingState,
  can: (principal, permission) => boolean,
  persistAndActivate: (expectedState, nextState, actor) => Promise<void> | void,
}
```

It reads `res.locals.communityPrincipal.subject` and `.workspace_id`; missing principal returns 401, wrong workspace or missing permission returns 403. It rejects request-supplied actor/owner fields. Every mutation produces an immutable next state and calls only `persistAndActivate`. The coordinator must atomically compare the `expectedState` generation and activate the new state only after consistent persistence. A viewer should have `finance:read` and `reports:read` only; owner permissions include `finance:match`, `finance:annotate`, `reports:read`, `finance:read`, `audit:read` and, if import is separately enabled, `finance:import`.

For `src/server/index.ts`, after the supervisor's workspace-auth middleware has set the trusted principal and after its recovery gate, import `createCommunityAccountingRouter` and mount `app.use('/api', createCommunityAccountingRouter({ workspaceId: runtimeWorkspaceId, getState: () => state, can: workspacePermissionPredicate, persistAndActivate: coordinatedPersistAndActivate }))` before the catch-all static route. The current `community-guard.ts` allowlist does not admit these paths and its local-token principal has no `workspace_id`; the supervisor's auth integration must authorize these methods and set membership. Do not synthesize membership from a request header or body. The older `createMatchDecisionRouter` and exclusion actions remain mounted by `routes/api.ts`; the supervisor should route the new accounting UI to this coordinator-backed router and disable or harden those legacy mutation paths before claiming the new safety invariants for the whole app.

Methods under `/api` are `GET /accounting`, `POST /accounting/proposals`, `POST /accounting/matches`, `PATCH /accounting/matches/:id/status`, `DELETE /accounting/matches/:id`, `POST /accounting/allocations`, `DELETE /accounting/allocations/:id`, `POST /accounting/classifications`, `POST /accounting/taxes`, `POST /accounting/dispositions`, `POST /accounting/exclusions`, `GET /accounting/reports`, `GET /accounting/reports/export.json`, `GET /accounting/reports/export.csv`, and `GET /accounting/audit`. Mutations require the current integer `revision`, except proposal generation, and return a new revision and audit ID. The accepted-state coordinator still must reject concurrent expected-generation changes.

For `web/src/main.tsx`, add `import { CommunityAccounting } from './pages/CommunityAccounting';`, a navigation item pointing to `/community-accounting`, and `<Route path="/community-accounting" element={<CommunityAccounting locale={language === 'de' ? 'de' : 'en'} />} />`. The component uses same-origin `/api` fetch; if the supervisor retains the current token gate during transition, provide a trusted authenticated fetch adapter at the integration boundary. The standalone synthetic browser harness in `tests/community-accounting-browser.mjs` mounts this component against its own loopback server and injected fictional session.

Exact UI insertion patch for the supervisor-owned file (the nav line belongs next to the existing `/matching` entry):

```diff
diff --git a/web/src/main.tsx b/web/src/main.tsx
@@ imports @@
+import { CommunityAccounting } from './pages/CommunityAccounting';
@@ App navigation entries @@
+            { to: '/community-accounting', label: language === 'de' ? 'Buchhaltung' : 'Accounting', tip: language === 'de' ? 'Abstimmung und Berichte' : 'Reconciliation and reports' },
@@ App Routes @@
+            <Route path="/community-accounting" element={<CommunityAccounting locale={language === 'de' ? 'de' : 'en'} />} />
```

The server insertion point is immediately after the JSON parser and workspace-auth/recovery middleware and before the existing `createApiRouter` mount. Keep legacy mutation paths disabled or separately reviewed when this router is enabled; otherwise their old persistence and exclusion behavior can bypass the new coordinator.

## Qualification and limits

The unit and HTTP tests use only fictional data. They check split/partial and many-to-one payments, direction, fees, balanced transfers, rational FX, three- and zero-decimal currencies as raw units, stale revisions, duplicate economic events, exclusions, private disposition, v1/v2 reload, invalid metadata, per-document rounding, VAT evidence, date filters, CSV escaping and role denial. Existing 16 decision tests remain unchanged. The isolated browser harness was attempted with both Chrome and Edge, but both headless launches timed out under the worker sandbox; therefore browser behavior and screenshots are **not qualified**. Route mounting, coordinator integration and provider-specific recognition are supervisor work before end-to-end release qualification.

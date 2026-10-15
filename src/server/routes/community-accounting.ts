import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MatchingState } from '../../core/types.js';
import { AccountingError, acceptAllocations, undoAllocation, classifyTransaction, classifyTax, setPrivateOrExcluded, createSafeExclusionRule, setExclusionRuleEnabled,exclusionRuleView,accountingOf } from '../../community/accounting/ledger.js';
import { accountingReport, reportCsv } from '../../community/accounting/reports.js';
import { proposeExactMatches } from '../../core/matching/community-proposals.js';
import { createManualDecision, reviewDecision, unmatchDecision, MatchDecisionError } from '../../core/matching/decisions.js';

export type AccountingPermission = 'finance:read' | 'finance:import' | 'finance:match' | 'finance:annotate' | 'reports:read' | 'audit:read';
export interface AccountingPrincipal { subject: string; workspace_id: string; role?: string }
export interface AccountingRouterDependencies {
  workspaceId: string;
  getState: () => MatchingState;
  can: (principal: AccountingPrincipal, permission: AccountingPermission) => boolean;
  persistAndActivate: (expectedState: MatchingState, nextState: MatchingState, actor: string) => Promise<void> | void;
}
/** Mount under the authenticated workspace. No request body supplies identity or permission. */
export function createCommunityAccountingRouter(deps: AccountingRouterDependencies): Router {
  const router = Router();
  const principal = (res: Response, permission: AccountingPermission): AccountingPrincipal => {
    const p = res.locals.communityPrincipal as AccountingPrincipal | undefined;
    if (!p || typeof p.subject !== 'string' || !p.subject || typeof p.workspace_id !== 'string' || !p.workspace_id) throw new AccountingError(401, 'AUTHENTICATION_REQUIRED', 'An authenticated accounting workspace is required');
    if (p.workspace_id !== deps.workspaceId || !deps.can(p, permission)) throw new AccountingError(403, 'PERMISSION_DENIED', 'Accounting permission denied');
    return p;
  };
  const run = (handler: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response) => {
    Promise.resolve().then(() => handler(req, res)).then(value => { if (!res.headersSent) res.json(value); }).catch(error => {
      if (error instanceof AccountingError || error instanceof MatchDecisionError) res.status(error.status).json({ code: error.code, error: error.message });
      else res.status(500).json({ code: 'ACCOUNTING_PERSISTENCE_FAILED', error: 'Accounting operation failed; reload before retrying' });
    });
  };
  const mutate = (permission: AccountingPermission, operation: (state: MatchingState, body: unknown, actor: string, req: Request) => MatchingState) =>
    run(async (req, res) => {
      const p = principal(res, permission); const expected = deps.getState();
      const next = operation(expected, req.body, p.subject, req);
      if(next!==expected)await deps.persistAndActivate(expected, next, p.subject);
      return { revision: accountingOf(next).revision, audit_id: next.audit_events.at(-1)?.audit_id };
    });
  router.get('/accounting', run((_req, res) => {
    principal(res, 'finance:read'); const state = deps.getState();
    return { revision: accountingOf(state).revision, transactions: [...state.transactions.values()], documents: [...state.documents.values()],
      allocations: accountingOf(state).allocations, match_groups: [...state.match_groups.values()], classifications: accountingOf(state).classifications,
      document_taxes: accountingOf(state).document_taxes,exclusion_rules:exclusionRuleView(state) };
  }));
  router.post('/accounting/allocations', mutate('finance:match', (state, body, actor) => acceptAllocations(state, body, actor)));
  router.delete('/accounting/allocations/:id', mutate('finance:match', (state, body, actor, req) => undoAllocation(state, String(req.params.id), (body as { revision?: unknown })?.revision, actor)));
  router.post('/accounting/classifications', mutate('finance:annotate', (state, body, actor) => classifyTransaction(state, body, actor)));
  router.post('/accounting/taxes', mutate('finance:annotate', (state, body, actor) => classifyTax(state, body, actor)));
  router.post('/accounting/dispositions', mutate('finance:annotate', (state, body, actor) => setPrivateOrExcluded(state, body, actor)));
  router.post('/accounting/exclusions', mutate('finance:annotate', (state, body, actor) => createSafeExclusionRule(state, body, actor)));
  router.patch('/accounting/exclusions/:id',mutate('finance:annotate',(state,body,actor,req)=>setExclusionRuleEnabled(state,String(req.params.id),body,actor)));
  router.post('/accounting/proposals', run(async (_req, res) => {
    const p = principal(res, 'finance:match'); const expected = deps.getState();
    const result = proposeExactMatches(expected);
    if (result.created.length) {
      result.state.accounting = { ...accountingOf(result.state), revision: accountingOf(expected).revision + 1 };
      await deps.persistAndActivate(expected, result.state, p.subject);
    }
    return { created: result.created, revision: accountingOf(result.state).revision };
  }));
  const decision = (operation: (state: MatchingState, actor: string, req: Request) => MatchingState) => run(async (req, res) => {
    const p = principal(res, 'finance:match'); const expected = deps.getState();
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || body.revision !== accountingOf(expected).revision) throw new AccountingError(409, 'STALE_REVISION', 'Accounting state changed; reload before reviewing');
    const next = operation(expected, p.subject, req);
    next.accounting = { ...accountingOf(next), revision: accountingOf(expected).revision + 1 };
    await deps.persistAndActivate(expected, next, p.subject);
    return { revision: accountingOf(next).revision, audit_id: next.audit_events.at(-1)?.audit_id };
  });
  router.post('/accounting/matches', decision((state, actor, req) => createManualDecision(state, {
    transaction_ids: req.body.transaction_ids, document_ids: req.body.document_ids, reason: req.body.reason,
  }, actor).state));
  router.patch('/accounting/matches/:id/status', decision((state, actor, req) => reviewDecision(state, String(req.params.id), {
    status: req.body.status, reason: req.body.reason,
  }, actor).state));
  router.delete('/accounting/matches/:id', decision((state, actor, req) => unmatchDecision(state, String(req.params.id), {
    reason: req.body.reason,
  }, actor).state));
  const report = (req: Request, res: Response) => accountingReport(deps.getState(), { start: String(req.query.start ?? ''), end: String(req.query.end ?? '') });
  router.get('/accounting/reports', run((req, res) => { principal(res, 'reports:read'); return report(req, res); }));
  router.get('/accounting/reports/export.json', run((req, res) => { principal(res, 'reports:read'); res.type('application/json'); return report(req, res); }));
  router.get('/accounting/reports/export.csv', run((req, res) => {
    principal(res, 'reports:read'); res.type('text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="community-accounting.csv"');
    res.send(reportCsv(report(req, res)));
  }));
  router.get('/accounting/audit', run((_req, res) => { principal(res, 'audit:read'); return { events: deps.getState().audit_events }; }));
  return router;
}

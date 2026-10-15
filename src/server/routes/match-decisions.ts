import { Router } from 'express';
import type { MatchGroup, MatchingState } from '../../core/types.js';
import { createManualDecision, reviewDecision, unmatchDecision, MatchDecisionError, type DecisionResult } from '../../core/matching/decisions.js';
import { saveState } from '../../storage/json-store.js';

function responseGroup(state: MatchingState, group: MatchGroup) {
  return {
    ...group,
    amount_total: group.amount_total_minor / 100,
    transactions: group.transaction_ids.map(id => {
      const transaction = state.transactions.get(id)!;
      return { ...transaction, amount: transaction.amount_minor / 100 };
    }),
    documents: group.document_ids.map(id => {
      const document = state.documents.get(id)!;
      return { ...document, amount: document.total_amount_minor / 100 };
    }),
  };
}

/** Must be mounted behind authenticated route authorization, never as a public router. */
export function createMatchDecisionRouter(
  getState: () => MatchingState,
  activate: (state: MatchingState) => void,
  persist: (state: MatchingState) => void = saveState,
): Router {
  const router = Router();
  const execute = (operation: () => DecisionResult, response: import('express').Response, removal = false) => {
    try {
      const result = operation();
      // File replacement is synchronous and atomic. A failed write leaves the
      // original in-memory state untouched; activation follows successful save.
      persist(result.state);
      activate(result.state);
      response.json(removal ? { ok: true, removed: result.group.match_group_id, history_retained: true } : responseGroup(result.state, result.group));
    } catch (error) {
      if (error instanceof MatchDecisionError) {
        response.status(error.status).json({ code: error.code, error: error.message });
      } else {
        response.status(500).json({ code: 'MATCH_PERSISTENCE_FAILED', error: 'The matching decision could not be saved. No in-memory decision was changed.' });
      }
    }
  };
  // The current supported runtime has one authenticated local owner, not multiple
  // users. Replace this actor through session identity when P02-W01 is integrated.
  const actor = (response: import('express').Response): string => {
    const subject = response.locals.communityPrincipal?.subject;
    if (typeof subject !== 'string' || !subject) throw new MatchDecisionError(401, 'AUTHENTICATION_REQUIRED', 'An authenticated matching reviewer is required');
    return subject;
  };
  router.post('/matches', (request, response) => execute(() => createManualDecision(getState(), request.body, actor(response)), response));
  router.patch('/matches/:id/status', (request, response) => execute(() => reviewDecision(getState(), request.params.id, request.body, actor(response)), response));
  router.delete('/matches/:id', (request, response) => execute(() => unmatchDecision(getState(), request.params.id, request.body, actor(response)), response, true));
  return router;
}

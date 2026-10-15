import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findUnmatched, findUnmatchedDocs } from '../engine.js';

/**
 * R-STRIPE-STRIPE_INCOME-001: Stripe charge → Income by charge ID
 * Stripe source (charge ID like "ch_3RflHP...") = Income Transaktionsnummer
 */
export const stripeIncomeChargeRule: MatchRule = {
  rule_id: 'R-STRIPE-STRIPE_INCOME-001',
  description: 'Match Stripe charges to Income orders by charge ID',
  apply(state: MatchingState) {
    const stripeCharges = findUnmatched(state, 'stripe', (t) =>
      t.meta.stripe_type === 'charge' && t.amount_minor > 0
    );

    const incomeDocs = findUnmatchedDocs(state, 'income');
    const incomeByTxn = new Map<string, typeof incomeDocs[0]>();
    for (const doc of incomeDocs) {
      const txnNum = doc.meta.transaktionsnummer as string | undefined;
      if (txnNum) incomeByTxn.set(txnNum, doc);
    }

    for (const charge of stripeCharges) {
      const chargeId = charge.meta.stripe_source as string | undefined;
      if (!chargeId) continue;

      const matchDoc = incomeByTxn.get(chargeId);
      if (matchDoc && matchDoc.total_amount_minor === charge.amount_minor) {
        createMatch(state, this.rule_id, [charge.transaction_id], [matchDoc.document_id], {
          type: 'income_stripe',
          charge_id: chargeId,
        });
        incomeByTxn.delete(chargeId);
      }
    }
  },
};

/**
 * R-STRIPE-STRIPE_INCOME-002: Stripe refund → Income credit note
 * Stripe refund source = Income CN- prefixed transaction
 */
export const stripeIncomeRefundRule: MatchRule = {
  rule_id: 'R-STRIPE-STRIPE_INCOME-002',
  description: 'Match Stripe refunds to Income credit notes',
  apply(state: MatchingState) {
    const stripeRefunds = findUnmatched(state, 'stripe', (t) =>
      t.meta.stripe_type === 'refund' && t.amount_minor < 0
    );

    const incomeDocs = findUnmatchedDocs(state, 'income');

    // Credit notes have negative amounts and CN- in belegnummer
    const creditNotes = incomeDocs.filter((d) =>
      d.source_document_ref.startsWith('CN-') && d.total_amount_minor < 0
    );
    const cnByTxn = new Map<string, typeof creditNotes[0]>();
    for (const cn of creditNotes) {
      const txnNum = cn.meta.transaktionsnummer as string | undefined;
      if (txnNum) cnByTxn.set(txnNum, cn);
    }

    for (const refund of stripeRefunds) {
      const chargeId = refund.meta.stripe_source as string | undefined;
      if (!chargeId) continue;

      const matchCn = cnByTxn.get(chargeId);
      if (matchCn && matchCn.total_amount_minor === refund.amount_minor) {
        createMatch(state, this.rule_id, [refund.transaction_id], [matchCn.document_id], {
          type: 'refund_stripe',
          charge_id: chargeId,
        });
        cnByTxn.delete(chargeId);
      }
    }
  },
};

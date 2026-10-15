/**
 * R-PAYPAL-SPLIT_PAY-001: Detect and annotate PayPal split payments.
 *
 * When PayPal splits a payment (part from balance, part from card/bank):
 * - Zahlung (-1000) is matched to invoice by earlier rules (Phase 6)
 * - Bankgutschrift (+300) is matched to Sparkasse by spkPaypalRule (Phase 1)
 * - These two match groups are SEPARATE but belong to the same payment
 *
 * This rule runs LAST and annotates both match groups with split info:
 * - paypal_split = true
 * - split_total, split_card_portion, split_balance_portion
 * - split_related_match_group = ID of the other group
 *
 * This allows the UI to show: "Splitzahlung: €700 PayPal-Guthaben + €300 Visa"
 */
import type { MatchRule } from '../engine.js';
import type { MatchingState, Transaction } from '../../types.js';

export const paypalSplitPayRule: MatchRule = {
  rule_id: 'R-PAYPAL-SPLIT_PAY-001',
  description: 'Detect PayPal split payments and annotate match groups with funding info',
  apply(state: MatchingState) {
    // Scan ALL PayPal transactions to find split pairs by Rechnungsnummer
    const allPaypal = [...state.transactions.values()].filter(t => t.source_system === 'paypal');

    const byRnr = new Map<string, Transaction[]>();
    for (const t of allPaypal) {
      const rnr = String(t.meta.rechnungsnummer ?? '');
      if (!rnr || rnr === 'undefined' || rnr === 'null' || rnr === '') continue;
      if (!byRnr.has(rnr)) byRnr.set(rnr, []);
      byRnr.get(rnr)!.push(t);
    }

    for (const [rnr, group] of byRnr) {
      if (group.length < 2) continue;

      const zahlungen = group.filter(t => t.amount_minor < 0);
      const gutschriften = group.filter(t =>
        t.amount_minor > 0 && String(t.meta.typ ?? '').includes('Bankgutschrift')
      );

      for (const zahlung of zahlungen) {
        for (const gutschrift of gutschriften) {
          const totalMinor = Math.abs(zahlung.amount_minor);
          const cardPortion = gutschrift.amount_minor;

          // Only handle SPLITS: Bankgutschrift < Zahlung
          if (cardPortion >= totalMinor) continue;

          const balancePortion = totalMinor - cardPortion;

          // Find match groups containing each transaction
          let zahlungMgId: string | null = null;
          let gutschriftMgId: string | null = null;

          for (const [mgId, mg] of state.match_groups) {
            if (mg.transaction_ids.includes(zahlung.transaction_id)) zahlungMgId = mgId;
            if (mg.transaction_ids.includes(gutschrift.transaction_id)) gutschriftMgId = mgId;
          }

          // Annotate the Zahlung match group (contains the invoice) with split info
          if (zahlungMgId) {
            const mg = state.match_groups.get(zahlungMgId)!;
            const ev = mg.evidence as Record<string, any>;
            ev.paypal_split = true;
            ev.split_total = totalMinor;
            ev.split_card_portion = cardPortion;
            ev.split_balance_portion = balancePortion;
            ev.split_funding = 'split';
            if (gutschriftMgId) ev.split_bank_match_group = gutschriftMgId;
          }

          // Annotate the Gutschrift match group (contains the bank transfer) with split info
          if (gutschriftMgId) {
            const mg = state.match_groups.get(gutschriftMgId)!;
            const ev = mg.evidence as Record<string, any>;
            ev.paypal_split = true;
            ev.split_total = totalMinor;
            ev.split_card_portion = cardPortion;
            ev.split_balance_portion = balancePortion;
            ev.split_funding = 'card_portion';
            if (zahlungMgId) ev.split_invoice_match_group = zahlungMgId;
          }

          // If Gutschrift is NOT matched yet, match it with the Zahlung group
          if (!gutschriftMgId && zahlungMgId) {
            const mg = state.match_groups.get(zahlungMgId)!;
            if (!mg.transaction_ids.includes(gutschrift.transaction_id)) {
              mg.transaction_ids.push(gutschrift.transaction_id);
              state.matched_transaction_ids.add(gutschrift.transaction_id);
            }
          }
        }
      }
    }
  },
};

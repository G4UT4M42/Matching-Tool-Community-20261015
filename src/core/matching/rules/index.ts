import type { MatchRule } from '../engine.js';

// Transfer rules (Umbuchungen)
import { spkStripePayoutRule, spkStripeFeeRule, spkStripeRefundRule } from './spk-stripe.js';
import { spkVisaRule } from './spk-visa.js';
import { spkPaypalRule } from './spk-paypal.js';
import { spkIncomeRule } from './spk-income.js';

// Income matching
import { paypalIncomeRule } from './paypal-income.js';
import { paypalRefundIncomeRule } from './paypal-refund.js';
import { stripeIncomeChargeRule, stripeIncomeRefundRule } from './stripe-income.js';

// Invoice/document matching
import { spkAmazonRefRule, spkAmazonInvoiceRule, spkAmazonAmountRule } from './spk-amazon.js';
import { spkInvoiceRefRule, spkInvoiceAmountRule, spkInvoiceDescRefRule } from './spk-invoice.js';
import { visaInvoiceAmountRule, visaFxInvoiceRule, visaInvoiceMerchantRule, visaAmazonRule } from './visa-invoice.js';
import { paypalInvoiceRule } from './paypal-invoice.js';

// Scanned invoice matching
import { scanInvoiceRefRule } from './scan-invoice.js';

// FX USD invoice matching
import { fxUsdInvoiceRule } from './fx-usd-invoice.js';

// AliExpress combo matching
import { aliexpressComboRule } from './aliexpress-combo.js';

// PSP fee summaries
import { stripeFeeMonthlyRule, paypalFeeMonthlyRule } from './psp-fee-summary.js';

// EUSt group matching
import { eustGroupRule } from './eust-group.js';

// Auto-match invoices by amount + date
import { autoMatchInvoiceRule } from './auto-match-invoice.js';

// PayPal internal
import { paypalInternalPairRule, paypalFxPairRule, paypalSmallPairRule, paypalInstantFundingRule } from './paypal-internal.js';

// PayPal split payment (balance + card)
import { paypalSplitPayRule } from './paypal-split.js';

/**
 * All rules in waterfall order (per docs/05_MATCHING_RULEBOOK/waterfall_order.md):
 * 1. Strongest reference rules first (cross-source transfers)
 * 2. Income matching (by transaction ID)
 * 3. Invoice matching (by reference)
 * 4. Amount/date fallback rules
 * 5. Fee and settlement rules
 * 6. Internal pair rules
 */
export const ALL_RULES: MatchRule[] = [
  // === Phase 1: Cross-source transfers (strongest evidence) ===
  spkStripePayoutRule,    // Sparkasse ↔ Stripe payout
  spkStripeFeeRule,       // Sparkasse ↔ Stripe fee
  spkStripeRefundRule,    // Sparkasse ↔ Stripe refund payout
  spkVisaRule,            // Sparkasse ↔ Visa card payment
  spkPaypalRule,          // Sparkasse ↔ PayPal bank transfer

  // === Phase 2: Income matching (by transaction ID) ===
  paypalRefundIncomeRule, // PayPal Rückzahlung → Income CN- credit notes
  paypalIncomeRule,       // PayPal → Income (general fallback after refunds)
  stripeIncomeChargeRule, // Stripe charge → Income
  stripeIncomeRefundRule, // Stripe refund → Income credit note

  // === Phase 3: Direct bank → Income ===
  spkIncomeRule,          // Sparkasse → Income by order ID

  // === Phase 4: Invoice matching (by reference) ===
  spkAmazonRefRule,       // Sparkasse Amazon → extracted_invoice
  spkAmazonInvoiceRule,   // Sparkasse Amazon → invoices.xlsx
  spkAmazonAmountRule,    // Sparkasse Amazon → Amazon docs by amount+date (fallback)
  spkInvoiceRefRule,      // Sparkasse → invoice by reference number
  spkInvoiceDescRefRule,  // Sparkasse → invoice where description = reference

  // === Phase 5: Visa invoice matching ===
  visaAmazonRule,         // Visa → unmatched Amazon docs by amount + date
  visaFxInvoiceRule,      // Visa FX → USD invoices
  visaInvoiceAmountRule,  // Visa → invoice by amount + date
  visaInvoiceMerchantRule, // Visa → invoice by merchant + amount

  // === Phase 6: PayPal invoice matching ===
  paypalInvoiceRule,      // PayPal → extracted_invoice

  // === Phase 7: FX/USD invoice matching (before scan fallback — needs USD amount)
  fxUsdInvoiceRule,        // USD invoices → Visa/PayPal FX by USD amount + date

  // === Phase 7b: AliExpress combo matching (single or combined orders → Visa charge)
  aliexpressComboRule,     // AliExpress orders → Visa by amount combos + date

  // === Phase 8: Scanned invoice matching ===
  scanInvoiceRefRule,      // Scanned invoices → bank by invoice number or amount+date

  // === Phase 8b: EUSt group matching ===
  eustGroupRule,           // EUSt split pairs (SVC + EUST) → bank by combined amount

  // === Phase 8c: PSP fee summaries ===
  stripeFeeMonthlyRule,   // Stripe fees → monthly fee summary doc
  paypalFeeMonthlyRule,   // PayPal fees → monthly fee summary doc

  // === Phase 9: Fallback amount matching ===
  spkInvoiceAmountRule,   // Sparkasse → invoice by counterparty + amount

  // === Phase 10: Auto-match open invoices by amount + expanding date window ===
  autoMatchInvoiceRule,   // All sources → invoice by amount (1d → 3d → 5d → no date)

  // === Phase 11: Internal pair rules ===
  paypalInternalPairRule, // PayPal purchase + Bankgutschrift pairs (incl. split payments)
  paypalSplitPayRule,     // PayPal split payment: link card portion to Visa/SPK + invoice
  paypalInstantFundingRule, // PayPal purchase + T0300 instant funding pairs
  paypalFxPairRule,       // PayPal FX conversion groups
  paypalSmallPairRule,    // PayPal small transaction pairs
];

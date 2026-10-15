import type { MatchRule } from '../engine.js';
import type { MatchingState } from '../../types.js';
import { createMatch, findSparkasse, findUnmatchedDocs } from '../engine.js';

/** Check if any minLen+ char substring of `needle` appears in `haystack` */
function hasSubstring(needle: string, haystack: string, minLen: number = 5): boolean {
  if (needle.length < minLen) return false;
  for (let i = 0; i <= needle.length - minLen; i++) {
    const sub = needle.slice(i, i + Math.min(needle.length - i, 8));
    if (haystack.includes(sub)) return true;
  }
  return false;
}

/**
 * R-BANK-SPK_INV-001: Sparkasse ↔ vendor invoice by reference
 * Parse "Rg. XXXXXXXX", invoice numbers, or payment references from Sparkasse description
 * to match against invoices and extracted invoices.
 */
export const spkInvoiceRefRule: MatchRule = {
  rule_id: 'R-BANK-SPK_INV-001',
  description: 'Match Sparkasse entries to invoices by reference number',
  apply(state: MatchingState) {
    // Get all unmatched docs from both invoice sources
    const allDocs = [
      ...findUnmatchedDocs(state, 'invoice_file'),
      ...findUnmatchedDocs(state, 'extracted_invoice'),
    ];

    // Build various lookup indexes for documents
    const docsByFilename = new Map<string, typeof allDocs[0]>();
    const docsByInvoiceNum = new Map<string, typeof allDocs[0]>();
    for (const doc of allDocs) {
      if (doc.filename) docsByFilename.set(doc.filename.toLowerCase(), doc);
      if (doc.source_document_ref) {
        docsByInvoiceNum.set(doc.source_document_ref.toLowerCase(), doc);
      }
    }

    // Match Sparkasse by payment reference (Zahlungsreferenz)
    const spkWithRef = findSparkasse(state, (s) =>
      s.payment_reference != null && s.payment_reference !== ''
    );

    for (const spk of spkWithRef) {
      const ref = String(spk.payment_reference!);
      // Try exact match by invoice number
      let doc = docsByInvoiceNum.get(ref.toLowerCase());
      // Try prefix match: payRef "CSH0562398" → ExtInv ref starts with "CSH0562398"
      if (!doc) {
        for (const [key, d] of docsByInvoiceNum) {
          if (key.startsWith(ref.toLowerCase()) && !state.matched_document_ids.has(d.document_id)) {
            doc = d;
            break;
          }
        }
      }
      if (doc && !state.matched_document_ids.has(doc.document_id)) {
        createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
          type: 'invoice_ref_match',
          reference: ref,
        });
        continue;
      }
    }

    // Match by description patterns: "Rg. XXXXXXXX v.", "NNNNNNNN v." (leading number), "LSE..." (LogoiX)
    const spkWithDesc = findSparkasse(state, (s) => {
      const desc = String(s.description_raw ?? '');
      return desc.includes('Rg.') || desc.includes('Rechnung') || desc.includes('v.') ||
        /^\d{6,}\s/.test(desc) || /^LSE\w+/i.test(desc);
    });

    for (const spk of spkWithDesc) {
      const desc = String(spk.description_raw ?? '');

      // Try "Rg. XXXXXXXX v."
      const rgMatch = desc.match(/Rg\.\s*(\d+)\s*v\./);
      if (rgMatch) {
        const invoiceNum = rgMatch[1];
        let doc = docsByInvoiceNum.get(invoiceNum.toLowerCase());
        // Prefix match: doc ref might be "38496690vom30" while we extracted "38496690"
        if (!doc) {
          for (const [key, d] of docsByInvoiceNum) {
            if (key.startsWith(invoiceNum.toLowerCase()) && Math.abs(spk.amount_minor) === Math.abs(d.total_amount_minor)) {
              doc = d;
              break;
            }
          }
        }
        if (doc && !state.matched_document_ids.has(doc.document_id)) {
          createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
            type: 'invoice_rg_match',
            invoice_number: invoiceNum,
          });
          continue;
        }
      }

      // Try leading number + " v." pattern: "202501037 v. 07.01.25" (HSH Immobilien, Fictional invoices)
      const leadingNumMatch = desc.match(/^(\d{6,})\s+v\./);
      if (leadingNumMatch) {
        const refNum = leadingNumMatch[1];
        let doc = docsByInvoiceNum.get(refNum.toLowerCase());
        if (!doc) {
          for (const [key, d] of docsByInvoiceNum) {
            if (key.startsWith(refNum.toLowerCase()) && !state.matched_document_ids.has(d.document_id)) {
              doc = d;
              break;
            }
          }
        }
        if (doc && !state.matched_document_ids.has(doc.document_id) &&
            Math.abs(spk.amount_minor) === Math.abs(doc.total_amount_minor)) {
          createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
            type: 'invoice_leading_ref',
            invoice_number: refNum,
          });
          continue;
        }
      }

      // Try "LSExxxxxxxxx" pattern (LogoiX): SPK desc matches extracted_invoice ref by prefix
      const lseMatch = desc.match(/^(LSE\w+)/i);
      if (lseMatch) {
        const lseRef = lseMatch[1];
        for (const [key, d] of docsByInvoiceNum) {
          if (key === lseRef.toLowerCase() && !state.matched_document_ids.has(d.document_id) &&
              Math.abs(spk.amount_minor) === Math.abs(d.total_amount_minor)) {
            createMatch(state, this.rule_id, [spk.transaction_id], [d.document_id], {
              type: 'invoice_lse_match',
              reference: lseRef,
            });
            break;
          }
        }
      }
    }
  },
};

/**
 * R-BANK-SPK_INV-002: Sparkasse ↔ extracted_invoice by counterparty + amount
 * Fallback: match by vendor name similarity + exact amount
 */
export const spkInvoiceAmountRule: MatchRule = {
  rule_id: 'R-BANK-SPK_INV-002',
  description: 'Match Sparkasse entries to invoices by counterparty and amount',
  apply(state: MatchingState) {
    const allDocs = [
      ...findUnmatchedDocs(state, 'invoice_file'),
      ...findUnmatchedDocs(state, 'extracted_invoice'),
    ];

    // Build amount-based index
    const docsByAmount = new Map<number, typeof allDocs[0][]>();
    for (const doc of allDocs) {
      const key = Math.abs(doc.total_amount_minor);
      if (!docsByAmount.has(key)) docsByAmount.set(key, []);
      docsByAmount.get(key)!.push(doc);
    }

    const spkEntries = findSparkasse(state, (s) => s.amount_minor !== 0);

    for (const spk of spkEntries) {
      const absAmount = Math.abs(spk.amount_minor);
      const candidates = docsByAmount.get(absAmount);
      if (!candidates || candidates.length === 0) continue;

      // Filter to unmatched candidates
      const available = candidates.filter(d => !state.matched_document_ids.has(d.document_id));
      if (available.length === 0) continue;

      const counterparty = (spk.counterparty_name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const desc = String(spk.description_raw ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, '');
      const searchText = counterparty + ' ' + desc;

      // Try to find a vendor name match among available candidates
      for (const doc of available) {
        const vendorName = (doc.supplier_name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const filename = (doc.filename ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

        // Fuzzy name matching: check if any 5+ char substring of vendor name
        // appears in counterparty or description
        const hasNameMatch =
          hasSubstring(vendorName, searchText, 5) ||
          (vendorName.length > 3 && hasSubstring(counterparty, vendorName, 5)) ||
          (filename.length > 4 && searchText.includes(filename.slice(0, 6)));

        if (hasNameMatch) {
          createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
            type: 'invoice_amount_vendor',
          });
          break;
        }
      }
    }
  },
};

/**
 * R-BANK-SPK_INV-003: Sparkasse ↔ extracted_invoice by description = ref
 * SPK description_raw matches extracted_invoice source_document_ref exactly.
 * Covers: MERKUR insurance, 3DJAKE, and other entries where the bank description
 * IS the document reference verbatim.
 */
export const spkInvoiceDescRefRule: MatchRule = {
  rule_id: 'R-BANK-SPK_INV-003',
  description: 'Match Sparkasse entries to extracted invoices where description equals document reference',
  apply(state: MatchingState) {
    const allDocs = findUnmatchedDocs(state, 'extracted_invoice');

    // Build ref index
    const docsByRef = new Map<string, typeof allDocs[0]>();
    for (const doc of allDocs) {
      if (doc.source_document_ref) {
        docsByRef.set(doc.source_document_ref.toLowerCase().trim(), doc);
      }
    }

    const spkEntries = findSparkasse(state, (s) => s.amount_minor !== 0);

    for (const spk of spkEntries) {
      const desc = String(spk.description_raw ?? '').trim();
      if (desc.length < 5) continue;

      const doc = docsByRef.get(desc.toLowerCase());
      if (doc && !state.matched_document_ids.has(doc.document_id) &&
          Math.abs(spk.amount_minor) === Math.abs(doc.total_amount_minor)) {
        createMatch(state, this.rule_id, [spk.transaction_id], [doc.document_id], {
          type: 'invoice_desc_ref',
        });
      }
    }
  },
};

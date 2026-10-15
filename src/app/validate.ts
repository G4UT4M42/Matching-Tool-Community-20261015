/**
 * Validate matching results against matched.xlsm ground truth.
 *
 * The ground truth lives in the "File Match" column of each sheet.
 * Values:
 *   "Match in Sheet X" / "Match in sheet X" → should be auto-matched
 *   "OK"                                     → excluded (no match needed)
 *   "No Match"                               → expected unmatched
 *   "Manual" / "Manual Invoice Link"         → manual match needed
 *   " " (space) / empty                      → no ground truth
 */

import { readFileSync } from 'fs';
import XLSX from 'xlsx';
import { ingestAndNormalize } from '../core/pipeline.js';
import { runMatchingEngine } from '../core/matching/engine.js';
import { ALL_RULES } from '../core/matching/rules/index.js';
import { fromMinor } from '../core/normalization/amount.js';

const dataDir = process.argv[2] || 'legacy/real-data-examples';
const matchedPath = `${dataDir}/matched.xlsm`;

console.log(`\n=== MATCHING TOOL V2 — VALIDATION ===`);
console.log(`Ground truth: ${matchedPath}\n`);

// Run the matching pipeline
const state = ingestAndNormalize({ dataDir });
runMatchingEngine(state, ALL_RULES);

// Load ground truth
const wb = XLSX.readFile(matchedPath);

interface GroundTruthRow {
  row_index: number;
  file_match: string;
  expected_matched: boolean;
  expected_ok: boolean;
  expected_no_match: boolean;
  expected_manual: boolean;
  identifier: string; // unique identifier to link back to our state
}

// Parse ground truth for each source
function parseGroundTruth(sheetName: string, identifierField: string): GroundTruthRow[] {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]) as Record<string, any>[];
  return rows.map((r, i) => {
    const fm = String(r['File Match'] ?? '').trim();
    const isMatch = fm.toLowerCase().startsWith('match in sheet') || fm.toLowerCase().startsWith('found in sheet');
    const isOk = fm === 'OK' || fm === 'Gebucht' || fm === 'BAR';
    const isNoMatch = fm.toLowerCase().startsWith('no match');
    const isManual = fm.toLowerCase().startsWith('manual');
    const identifier = String(r[identifierField] ?? `row_${i + 1}`);

    return {
      row_index: i + 1,
      file_match: fm,
      expected_matched: isMatch,
      expected_ok: isOk,
      expected_no_match: isNoMatch,
      expected_manual: isManual,
      identifier,
    };
  });
}

// Validation stats
interface ValidationResult {
  sheet: string;
  total: number;
  expected_auto_match: number;
  expected_ok: number;
  expected_no_match: number;
  expected_manual: number;
  expected_unknown: number;
  actual_matched: number;
  true_positives: number;    // expected matched AND actually matched
  false_negatives: number;   // expected matched BUT NOT actually matched
  false_positives: number;   // NOT expected matched BUT actually matched
  true_negatives: number;    // NOT expected matched AND NOT actually matched
  unmatched_details: string[];
}

function validateSheet(
  sheetName: string,
  identifierField: string,
  sourceSystem: string,
  isDocument: boolean,
): ValidationResult {
  const gt = parseGroundTruth(sheetName, identifierField);

  const result: ValidationResult = {
    sheet: sheetName,
    total: gt.length,
    expected_auto_match: gt.filter(r => r.expected_matched).length,
    expected_ok: gt.filter(r => r.expected_ok).length,
    expected_no_match: gt.filter(r => r.expected_no_match).length,
    expected_manual: gt.filter(r => r.expected_manual).length,
    expected_unknown: 0,
    actual_matched: 0,
    true_positives: 0,
    false_negatives: 0,
    false_positives: 0,
    true_negatives: 0,
    unmatched_details: [],
  };
  result.expected_unknown = gt.length - result.expected_auto_match - result.expected_ok - result.expected_no_match - result.expected_manual;

  // For each ground truth row, find the corresponding item in our state
  for (const row of gt) {
    let isMatched = false;

    if (isDocument) {
      // For documents (Income, extracted_invoice), match by source system
      for (const doc of state.documents.values()) {
        if (doc.source_system !== sourceSystem) continue;
        if (doc.meta.row_index === row.row_index) {
          isMatched = state.matched_document_ids.has(doc.document_id);
          break;
        }
      }
    } else {
      // For transactions, match by source system and row index
      for (const txn of state.transactions.values()) {
        if (txn.source_system !== sourceSystem) continue;
        if (txn.meta.row_index === row.row_index) {
          isMatched = state.matched_transaction_ids.has(txn.transaction_id);
          break;
        }
      }
    }

    if (isMatched) result.actual_matched++;

    if (row.expected_matched) {
      if (isMatched) result.true_positives++;
      else {
        result.false_negatives++;
        result.unmatched_details.push(`Row ${row.row_index}: "${row.file_match}" — ${row.identifier}`);
      }
    } else if (!row.expected_ok && !row.expected_no_match && !row.expected_manual && row.file_match !== '' && row.file_match !== ' ') {
      // unexpected category
      if (isMatched) result.false_positives++;
      else result.true_negatives++;
    } else {
      if (isMatched) result.false_positives++; // matched something we didn't expect
      else result.true_negatives++;
    }
  }

  return result;
}

// Validate each sheet
const results: ValidationResult[] = [
  validateSheet('Sparkasse', 'Buchungsreferenz', 'sparkasse', false),
  validateSheet('Visa', 'Buchungsreferenz', 'visa', false),
  validateSheet('Paypal', 'Transaktionscode', 'paypal', false),
  validateSheet('Stripe', 'id', 'stripe', false),
  validateSheet('Income', 'Belegnummer', 'income', true),
  validateSheet('extracted_invoice', 'filename', 'extracted_invoice', true),
];

// Print results
console.log('=' .repeat(80));
console.log('VALIDATION RESULTS');
console.log('='.repeat(80));

for (const r of results) {
  const recall = r.expected_auto_match > 0 ? (r.true_positives / r.expected_auto_match * 100).toFixed(1) : 'N/A';
  const precision = r.actual_matched > 0 ? (r.true_positives / r.actual_matched * 100).toFixed(1) : 'N/A';

  console.log(`\n--- ${r.sheet} ---`);
  console.log(`  Total rows:          ${r.total}`);
  console.log(`  Expected auto-match: ${r.expected_auto_match}`);
  console.log(`  Expected OK:         ${r.expected_ok}`);
  console.log(`  Expected No Match:   ${r.expected_no_match}`);
  console.log(`  Expected Manual:     ${r.expected_manual}`);
  console.log(`  Actually matched:    ${r.actual_matched}`);
  console.log(`  True positives:      ${r.true_positives} (expected match AND matched)`);
  console.log(`  False negatives:     ${r.false_negatives} (expected match BUT NOT matched)`);
  console.log(`  False positives:     ${r.false_positives} (NOT expected BUT matched)`);
  console.log(`  Recall:              ${recall}%`);
  console.log(`  Precision:           ${precision}%`);

  if (r.false_negatives > 0 && r.unmatched_details.length <= 10) {
    console.log(`  Missed matches:`);
    for (const d of r.unmatched_details) {
      console.log(`    - ${d}`);
    }
  } else if (r.false_negatives > 0) {
    console.log(`  Missed matches: ${r.false_negatives} (showing first 10)`);
    for (const d of r.unmatched_details.slice(0, 10)) {
      console.log(`    - ${d}`);
    }
  }
}

// Overall summary
const totalExpected = results.reduce((s, r) => s + r.expected_auto_match, 0);
const totalTP = results.reduce((s, r) => s + r.true_positives, 0);
const totalFN = results.reduce((s, r) => s + r.false_negatives, 0);
const totalFP = results.reduce((s, r) => s + r.false_positives, 0);
const totalMatched = results.reduce((s, r) => s + r.actual_matched, 0);

console.log('\n' + '='.repeat(80));
console.log('OVERALL SUMMARY');
console.log('='.repeat(80));
console.log(`Expected auto-matchable: ${totalExpected}`);
console.log(`True positives:          ${totalTP}`);
console.log(`False negatives:         ${totalFN}`);
console.log(`False positives:         ${totalFP}`);
console.log(`Overall recall:          ${(totalTP / totalExpected * 100).toFixed(1)}%`);
console.log(`Overall precision:       ${(totalTP / totalMatched * 100).toFixed(1)}%`);
console.log(`Match engine groups:     ${state.match_groups.size}`);

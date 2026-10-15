import { ingestAndNormalize } from '../core/pipeline.js';
import { runMatchingEngine } from '../core/matching/engine.js';
import { ALL_RULES } from '../core/matching/rules/index.js';
import { saveState } from '../storage/json-store.js';
import { saveStateToDb } from '../storage/sqlite-store.js';
import { closeDb } from '../storage/db.js';
import { fromMinor } from '../core/normalization/amount.js';

const dataDir = process.argv[2] || 'legacy/real-data-examples';

console.log(`\n=== MATCHING TOOL V2 ===`);
console.log(`Data directory: ${dataDir}\n`);

// Step 1: Ingest & Normalize
console.log('Step 1: Ingesting and normalizing...');
const state = ingestAndNormalize({ dataDir });

console.log(`  Transactions: ${state.transactions.size}`);
console.log(`  Documents: ${state.documents.size}`);

// Count by source
const txnBySource = new Map<string, number>();
for (const t of state.transactions.values()) {
  txnBySource.set(t.source_system, (txnBySource.get(t.source_system) ?? 0) + 1);
}
for (const [src, count] of txnBySource) {
  console.log(`    ${src}: ${count} transactions`);
}

const docBySource = new Map<string, number>();
for (const d of state.documents.values()) {
  docBySource.set(d.source_system, (docBySource.get(d.source_system) ?? 0) + 1);
}
for (const [src, count] of docBySource) {
  console.log(`    ${src}: ${count} documents`);
}

// Step 2: Run matching engine
console.log('\nStep 2: Running matching engine...');
runMatchingEngine(state, ALL_RULES);

console.log(`  Match groups: ${state.match_groups.size}`);
console.log(`  Matched transactions: ${state.matched_transaction_ids.size} / ${state.transactions.size}`);
console.log(`  Matched documents: ${state.matched_document_ids.size} / ${state.documents.size}`);

// Report by rule
const byRule = new Map<string, number>();
for (const mg of state.match_groups.values()) {
  byRule.set(mg.rule_id, (byRule.get(mg.rule_id) ?? 0) + 1);
}
console.log('\n  Matches by rule:');
for (const [rule, count] of [...byRule.entries()].sort()) {
  console.log(`    ${rule}: ${count}`);
}

// Unmatched summary
const unmatchedTxns = [...state.transactions.values()].filter(
  (t) => !state.matched_transaction_ids.has(t.transaction_id)
);
const unmatchedBySource = new Map<string, number>();
for (const t of unmatchedTxns) {
  unmatchedBySource.set(t.source_system, (unmatchedBySource.get(t.source_system) ?? 0) + 1);
}
console.log('\n  Unmatched transactions by source:');
for (const [src, count] of unmatchedBySource) {
  console.log(`    ${src}: ${count}`);
}

// Save state
console.log('\nSaving state...');
saveState(state);
console.log('  Saved to data/state.json');

saveStateToDb(state);
closeDb();
console.log('  Saved to data/matching.db');
console.log('Done!');

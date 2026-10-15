import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n, registerLocale } from '../web/src/i18n/index.mjs';

test('English default and stable translated keys', () => {
  const i18n = createI18n();
  assert.equal(i18n.locale, 'en');
  assert.equal(i18n.t('migration.title'), 'Import Existing Installation');
  assert.equal(i18n.t('matching.reviewRequired', { count: 3 }), '3 matches require review');
});
test('switching to a partial locale falls back to English', () => {
  registerLocale('de', { 'common.save': 'Speichern' });
  const i18n = createI18n('de');
  assert.equal(i18n.t('common.save'), 'Speichern');
  assert.equal(i18n.t('migration.title'), 'Import Existing Installation');
  assert.equal(i18n.setLocale('xx'), 'en');
  assert.equal(i18n.t('common.save'), 'Save');
});
test('formatting cannot change signed integer cent totals', () => {
  const i18n = createI18n('en');
  const minor = -12599;
  assert.match(i18n.formatAmount(minor, 'EUR'), /125/);
  assert.equal(minor, -12599);
  assert.throws(() => i18n.formatAmount(0.75, 'EUR'));
  assert.throws(() => i18n.formatDate('2026-02-30'));
});

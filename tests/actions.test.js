'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sources = ['app.js', 'features.js'].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
const all = [html].concat(sources).join('\n');

const actions = [...new Set([...all.matchAll(/data-action=["']([^"']+)["']/g)].map((m) => m[1]))].sort();
const handlers = new Set([...all.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map((m) => m[1]));

test('every declared data-action has a real click handler', () => {
  assert.ok(actions.length >= 90, `expected the full app surface, found ${actions.length} actions`);
  const missing = actions.filter((action) => !handlers.has(action));
  assert.deepEqual(missing, [], `buttons without handlers: ${missing.join(', ')}`);
});

test('both declared forms are wired to app or feature logic', () => {
  const forms = [...html.matchAll(/<form\b[^>]*>/gi)].map((match) => match[0]);
  assert.ok(forms.length > 0, 'no forms found');
  forms.forEach((form) => {
    const id = (form.match(/id="([^"]+)"/) || [])[1];
    assert.ok(id, 'every form needs an id so it can be wired');
    assert.ok(
      sources.some((source) => source.includes(`'${id}'`) || source.includes(`"${id}"`)),
      `form ${id} is never referenced by JavaScript`
    );
  });
});

test('critical advanced controls remain present', () => {
  for (const action of [
    'anaRange', 'anaApplyCustom', 'anaExportCSV', 'anaPrintReport',
    'ttEdit', 'ttDelete', 'ttDuplicate', 'ttMark', 'ttHistory',
    'notifRead', 'notifClear', 'notifTest', 'triggerManualSync',
    'exportData', 'mergeImport', 'replaceImport', 'continueAsGuest'
  ]) {
    assert.ok(actions.includes(action), `missing control ${action}`);
  }
});

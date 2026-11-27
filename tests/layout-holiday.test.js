'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const features = fs.readFileSync(path.join(root, 'features.js'), 'utf8');

test('app.js no longer forces narrow 520px/560px inline container caps', () => {
  assert.doesNotMatch(app, /dashboardMaxWidth|520px|560px/);
  assert.match(app, /appContainer\.style\.maxWidth\s*=\s*''/);
});

test('dashboard and calendar responsive layout containers are cleanly configured', () => {
  assert.match(html, /\.app-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/);
  assert.match(html, /\.dash-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*3fr\)\s*minmax\(280px,\s*2fr\)/);
  assert.match(html, /\.stat-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(html, /\.cal-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1\.1fr\)\s*minmax\(0,\s*1fr\)/);
  assert.match(html, /\.subjects-toolbar[\s\S]*?id="filterChipsRow"[\s\S]*?id="subjectsSectionAddBtn"/);
  assert.match(html, /\.day-sub-entry\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?min-width:\s*0;/);
  assert.match(html, /\.day-sub-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?max-width:\s*100%;/);
});

test('holiday dates disable attendance marking without deleting existing data', () => {
  assert.match(app, /if\s*\(\s*appState\.calendar\[dateStr\]\s*&&\s*appState\.calendar\[dateStr\]\.isHoliday\s*\)\s*\{[\s\S]*?return false;/);
  assert.match(app, /const disabledAttr = isHoliday \? 'disabled aria-disabled="true"' : '';/);
  assert.match(app, /holidayBtn\.textContent = isHoliday \? 'Remove Holiday' : 'Mark Holiday';/);
  assert.match(features, /if\s*\(\s*result === false\s*\)\s*return false;/);
});

test('no leftover one-off migration slop files remain in the repository root', () => {
  for (const slop of ['_appjs.py', '_markup.py', '_patch1.py', 'DELIVERY_SUMMARY.md']) {
    assert.equal(fs.existsSync(path.join(root, slop)), false, `${slop} should be removed`);
  }
});

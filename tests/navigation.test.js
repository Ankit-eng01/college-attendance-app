'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const features = fs.readFileSync(path.join(root, 'features.js'), 'utf8');

const EXPECTED_TABS = [
  'dashboard', 'subjects', 'calendar', 'timetable', 'analytics',
  'notifications', 'calculator', 'settings'
];

function navBlock(startPattern) {
  const start = html.search(startPattern);
  assert.notEqual(start, -1, `missing nav matching ${startPattern}`);
  const end = html.indexOf('</nav>', start);
  assert.notEqual(end, -1, 'nav block was not closed');
  return html.slice(start, end);
}

function tabsIn(block) {
  return Array.from(block.matchAll(/data-tab="([^"]+)"/g), (match) => match[1]);
}

test('sidebar exposes all eight real destinations exactly once', () => {
  const tabs = tabsIn(navBlock(/<nav class="sidebar-nav">/));
  assert.deepEqual([...tabs].sort(), [...EXPECTED_TABS].sort());
  assert.equal(new Set(tabs).size, tabs.length, 'sidebar must not duplicate a destination');
});

test('compact mobile nav exposes all eight destinations with accessible names', () => {
  const block = navBlock(/<nav class="bottom-nav"[^>]*aria-label="Mobile navigation"/);
  const tabs = tabsIn(block);
  assert.deepEqual([...tabs].sort(), [...EXPECTED_TABS].sort());
  assert.equal(new Set(tabs).size, tabs.length, 'mobile nav must not duplicate a destination');
  for (const label of ['Dashboard', 'Subjects', 'Calendar', 'Timetable', 'Analytics', 'Notifications', 'Simulator', 'Settings']) {
    assert.ok(block.includes(`aria-label="${label}"`), `mobile nav is missing the accessible name ${label}`);
  }
});

test('dashboard and subjects are distinct nav entries but share the real subjects view', () => {
  const sidebar = navBlock(/<nav class="sidebar-nav">/);
  const mobile = navBlock(/<nav class="bottom-nav"[^>]*aria-label="Mobile navigation"/);
  for (const block of [sidebar, mobile]) {
    assert.match(block, /data-action="switchTab" data-tab="dashboard"/);
    assert.match(block, /data-action="switchTab" data-tab="subjects"/);
  }
  assert.match(app, /tab === 'dashboard' \|\| tab === 'subjects'[\s\S]{0,180}viewSubjects/);
  assert.match(app, /activeTab: 'dashboard'/);
  assert.match(app, /activeTab: raw\.activeTab \|\| 'dashboard'/);
});

test('the feature layer refreshes the tab-specific surfaces for every destination', () => {
  for (const tab of ['analytics', 'timetable', 'calendar', 'calculator', 'notifications', 'settings']) {
    assert.match(features, new RegExp(`tab === '${tab}'`));
  }
  assert.match(features, /switchTab\(liveState\(\)\.activeTab \|\| 'dashboard'\)/);
});

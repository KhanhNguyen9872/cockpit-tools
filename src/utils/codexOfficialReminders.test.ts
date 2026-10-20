import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_OFFICIAL_REMINDERS_KEY, CODEX_OFFICIAL_REMINDERS_CHANGED, readCodexOfficialReminders, setCodexOfficialRemindersEnabled, markCodexOfficialEntrySeen } from './codexOfficialReminders';
import { canChooseCodexServiceAuthorization, shouldRecommendCodexServiceAuthorization, requestCodexOfficialAuthorizationCheck, takeCodexOfficialAuthorizationCheck, requestCodexOfficialAuthorizationManagement, takeCodexOfficialAuthorizationManagement } from './codexAccountServiceNavigation';
import type { CodexAccount } from '../types/codex';

test('global opt-out persists across readers and never disables manual authorization for any plan', () => {
  const previous = globalThis.window;
  const values = new Map<string, string>();
  const window = Object.assign(new EventTarget(), { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  Object.assign(globalThis, { window });
  let events = 0; window.addEventListener(CODEX_OFFICIAL_REMINDERS_CHANGED, () => events++);
  try {
    const team = { id: 'team', plan_type: 'team' } as CodexAccount;
    const plus = { id: 'plus', plan_type: 'plus' } as CodexAccount;
    assert.equal(shouldRecommendCodexServiceAuthorization(team), true);
    setCodexOfficialRemindersEnabled(false); markCodexOfficialEntrySeen();
    assert.equal(shouldRecommendCodexServiceAuthorization(team), false);
    assert.equal(shouldRecommendCodexServiceAuthorization(plus), false);
    assert.equal(canChooseCodexServiceAuthorization(team), true);
    requestCodexOfficialAuthorizationCheck({ running: true, restarted: true });
    assert.equal(takeCodexOfficialAuthorizationCheck(), null, 'opt-out suppresses service startup too');
    requestCodexOfficialAuthorizationManagement();
    assert.equal(takeCodexOfficialAuthorizationManagement(), true, 'manual entry stays usable');
    assert.deepEqual(readCodexOfficialReminders(), { disabled: true, entrySeen: true });
    setCodexOfficialRemindersEnabled(true);
    assert.equal(shouldRecommendCodexServiceAuthorization(team), true);
    requestCodexOfficialAuthorizationCheck({ running: true, restarted: true });
    assert.notEqual(takeCodexOfficialAuthorizationCheck(), null);
    assert.equal(events, 3);
    assert.deepEqual(JSON.parse(values.get(CODEX_OFFICIAL_REMINDERS_KEY)!), { version: 2, disabled: false, entrySeen: true });
  } finally { Object.assign(globalThis, { window: previous }); }
});

test('retired per-account dismissals do not hide rows or become a global opt-out', () => {
  const previous = globalThis.window;
  let raw = JSON.stringify({ version: 1, dismissedAccountIds: ['team'], entrySeen: true });
  Object.assign(globalThis, { window: Object.assign(new EventTarget(), { localStorage: { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } } }) });
  try {
    assert.deepEqual(readCodexOfficialReminders(), { disabled: false, entrySeen: true });
    setCodexOfficialRemindersEnabled(false);
    assert.deepEqual(JSON.parse(raw), { version: 2, disabled: true, entrySeen: true });
  } finally { Object.assign(globalThis, { window: previous }); }
});

test('failed storage writes never claim a successful opt-out', () => {
  const previous = globalThis.window;
  const window = Object.assign(new EventTarget(), { localStorage: { getItem: () => '{broken', setItem: () => { throw new Error('disk full'); } } });
  Object.assign(globalThis, { window });
  let events = 0; window.addEventListener(CODEX_OFFICIAL_REMINDERS_CHANGED, () => events++);
  try {
    assert.equal(readCodexOfficialReminders().disabled, false);
    assert.throws(() => setCodexOfficialRemindersEnabled(false), /disk full/);
    assert.equal(events, 0);
  } finally { Object.assign(globalThis, { window: previous }); }
});

test('failed storage reads never overwrite a previous preference', () => {
  const previous = globalThis.window; let writes = 0;
  Object.assign(globalThis, { window: Object.assign(new EventTarget(), { localStorage: {
    getItem: () => { throw new Error('storage unavailable'); }, setItem: () => { writes++; },
  } }) });
  try {
    assert.equal(readCodexOfficialReminders().disabled, false);
    assert.throws(() => setCodexOfficialRemindersEnabled(false), /storage unavailable/);
    assert.equal(writes, 0);
  } finally { Object.assign(globalThis, { window: previous }); }
});

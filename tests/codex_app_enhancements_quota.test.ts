import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/modules/codex_app_enhancements/quota.js', import.meta.url), 'utf8');
const fixture = 'var gate=atom(U,(host,{get:read})=>{let account=read(auth);if(account.authMethod!==`chatgpt`)return {hardBlocked:false};return {hardBlocked:read(usage).rate_limit?.allowed===!1}}),blocked=family(U,(host,{get:read})=>read(gate,host).hardBlocked);';
const url = 'app://-/assets/app-initial-fixture.js';
function runtime() {
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  return { context, api: context.__cockpitQuotaCompat };
}

test('quota compatibility changes only a verified local derived send guard', () => {
  const { context, api } = runtime();
  const result = api.transform(fixture, url);
  assert.equal(result.ok, true);
  assert.ok(result.patchedSource.includes('rate_limit?.allowed===!1'));
  assert.ok(result.patchedSource.includes('hardBlocked:read(usage).rate_limit?.allowed===!1'));
  const state = { rate_limit: { allowed: false, limit_reached: true }, credits: { balance: 0 } };
  context.U = {};
  context.auth = {};
  context.usage = {};
  context.atom = (_scope: unknown, read: unknown) => read;
  context.family = (_scope: unknown, read: unknown) => read;
  context.__cockpitEnhancements = { quotaCompat: true };
  vm.runInContext(result.patchedSource, context);
  const get = (target: unknown) => target === context.auth
    ? { authMethod: 'chatgpt' }
    : target === context.usage ? state : context.gate('local', { get });
  assert.equal(context.blocked('local', { get }), false);
  assert.equal(context.blocked('remote', { get }), true);
  context.__cockpitEnhancements.quotaCompat = false;
  assert.equal(context.blocked('local', { get }), true);
  assert.deepEqual(state, { rate_limit: { allowed: false, limit_reached: true }, credits: { balance: 0 } });
});

test('unknown, ambiguous or previously transformed contracts retain the original source', () => {
  const { api } = runtime();
  for (const input of [fixture.replace('`chatgpt`', '`other`'), fixture + fixture, fixture.replace('rate_limit?.allowed', 'unrelated'), 'unrelated']) {
    const result = api.transform(input, url);
    assert.equal(result.ok, false);
    assert.equal(result.patchedSource, input);
  }
  assert.equal(api.transform(fixture, 'https://example.test/app.js').ok, false);
  const once = api.transform(fixture, url).patchedSource;
  assert.equal(api.transform(once, url).ok, false);
});

test('current account-verified quota family remains supported without modifying its snapshot', () => {
  const { api } = runtime();
  const verified = 'var quota=family(U,(host,{get:read})=>{let identity=read(auth),snapshot=read(usage);if(snapshot.user_id!==identity.userId||snapshot.account_id!==identity.authenticatedAccountId)return empty;return {hardBlocked:snapshot.rate_limit?.allowed===!1}}),blocked=family(U,(host,{get:read})=>read(quota,host).hardBlocked);';
  const result = api.transform(verified, url);
  assert.equal(result.ok, true);
  assert.ok(result.patchedSource.includes('snapshot.account_id!==identity.authenticatedAccountId'));
  assert.ok(result.patchedSource.includes('hardBlocked:snapshot.rate_limit?.allowed===!1'));
});

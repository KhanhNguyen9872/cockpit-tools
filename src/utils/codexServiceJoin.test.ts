import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodexAccount } from '../types/codex';
import type { ChatGptPlanAccount } from '../services/chatgptPlanService';
import type { CodexLocalAccessState } from '../types/codexLocalAccess';
import { resolveCodexServiceJoinPlan, reuseCodexServiceJoin } from './codexServiceJoin';

const source = { id: 'source', email: 'a@example.com', auth_mode: 'oauth' } as CodexAccount;
const grant = { id: 'grant', source_account_id: source.id, source_binding_valid: true, connected: true, needs_reauth: false } as ChatGptPlanAccount;

test('saved official authorization is reused without model verification or another login, even after removal', () => {
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [grant], [], false), { kind: 'saved', mode: 'official', registrationId: grant.id });
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [{ ...grant, last_service_mode: 'official', verified_at: undefined, verified_model: undefined }], [], true), { kind: 'saved', mode: 'official', registrationId: grant.id });
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [{ ...grant, source_binding_valid: false }], [], true), { kind: 'saved', mode: 'official', registrationId: grant.id }, 'pending association is rechecked by the backend, not replaced with browser login');
});

test('last successful local choice survives membership removal and an expired official session', () => {
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [{ ...grant, last_service_mode: 'codex', needs_reauth: true }], [], true), { kind: 'saved', mode: 'codex', registrationId: grant.id });
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [grant], [source.id], true), { kind: 'saved', mode: 'codex', registrationId: grant.id });
});

test('missing or ambiguous grants ask for choice; terminal invalid official state never silently becomes local', () => {
  assert.equal(resolveCodexServiceJoinPlan(source, [], [], true).kind, 'choice');
  assert.equal(resolveCodexServiceJoinPlan(source, [], [], false).kind, 'local');
  assert.equal(resolveCodexServiceJoinPlan(source, [grant, { ...grant, id: 'other' }], [], false).kind, 'choice');
  for (const value of [{ ...grant, connected: false }, { ...grant, needs_reauth: true }, { ...grant, source_binding_error: 'CHATGPT_PLAN_SOURCE_CHANGED' }]) assert.equal(resolveCodexServiceJoinPlan(source, [value], [], false).kind, 'reauthorize');
  assert.equal(resolveCodexServiceJoinPlan({ ...source, auth_mode: 'apikey' }, [grant], [], true).kind, 'local');
});

test('only committed real membership is announced; model is never supplied and transient errors preserve the route', async () => {
  const calls: unknown[][] = [], applied: unknown[][] = [];
  const state = { collection: { accountIds: ['source', 'other'], officialAccountBindings: { source: 'grant' } } } as unknown as CodexLocalAccessState;
  const dependencies = { setMode: async (...args: any[]) => { calls.push(args); return state; }, applied: (...args: any[]) => { applied.push(args); } };
  const result = await reuseCodexServiceJoin(source, [grant], [], dependencies);
  assert.equal(result.kind, 'joined');
  assert.deepEqual(calls, [['source', 'official', 'grant', { intent: 'join' }]]);
  assert.deepEqual(applied, [[['source'], ['source']]]);
  dependencies.setMode = async () => { throw new Error('CHATGPT_PLAN_NETWORK'); };
  await assert.rejects(reuseCodexServiceJoin(source, [grant], [], dependencies), /CHATGPT_PLAN_NETWORK/);
  dependencies.setMode = async () => { throw new Error('CHATGPT_PLAN_REAUTH_REQUIRED'); };
  assert.equal((await reuseCodexServiceJoin(source, [grant], [], dependencies)).kind, 'reauthorize');
  dependencies.setMode = async () => ({ collection: { accountIds: ['source'], officialAccountBindings: {} } }) as CodexLocalAccessState;
  await assert.rejects(reuseCodexServiceJoin(source, [grant], [], dependencies), /CHATGPT_PLAN_SERVICE_CHANGED/);
  assert.equal(applied.length, 1);
});

test('batch joins keep real reused endpoint IDs and only send unresolved accounts to one chooser', async () => {
  const { prepareCodexServiceJoins } = await import('./codexServiceJoin');
  const states: unknown[] = [];
  const state = { collection: { accountIds: ['source'], officialAccountBindings: { source: 'grant' } } } as unknown as CodexLocalAccessState;
  const result = await prepareCodexServiceJoins([source, { ...source, id: 'new' }, { ...source, id: 'api', auth_mode: 'apikey' }], [grant], [],
    (value) => states.push(value), async (account) => account.id === 'source'
      ? { kind: 'joined', state, selectedIds: ['source'] }
      : { kind: account.id === 'new' ? 'choice' : 'local' });
  assert.deepEqual(result, { localIds: ['api'], choiceIds: ['new'], resumedIds: ['source'] });
  assert.deepEqual(states, [state]);
});

test('draft planning reads canonical mode without committing it or silently replacing a missing bound grant', () => {
  const oldLocal = { ...grant, last_service_mode: 'codex' as const };
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [oldLocal], ['source'], true, { source: 'grant' }), { kind: 'saved', mode: 'official', registrationId: 'grant' });
  assert.deepEqual(resolveCodexServiceJoinPlan(source, [{ ...grant, last_service_mode: 'official' }], ['source'], true, {}), { kind: 'saved', mode: 'codex', registrationId: 'grant' });
  assert.equal(resolveCodexServiceJoinPlan(source, [grant], ['source'], false, { source: 'missing' }).kind, 'reauthorize');
  assert.equal(resolveCodexServiceJoinPlan(source, [], ['source'], false, { source: 'missing' }).kind, 'reauthorize');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('./codexLocalAccessService.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness(invoke: (command: string) => Promise<unknown>) {
  const exports: Record<string, any> = {};
  const checks: any[] = [];
  vm.runInNewContext(compiled, { exports, performance, console: { info() {} }, require(name: string) {
    if (name === '@tauri-apps/api/core') return { invoke };
    if (name === '../utils/codexAccountServiceNavigation') return { requestCodexOfficialAuthorizationCheck: (value: unknown) => checks.push(value) };
    throw new Error(name);
  } });
  return { service: exports, checks };
}
const state = { running: true, collection: { enabled: true } };
test('startup completes before requesting a prompt and does not wait for authorization', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((next) => { resolve = next; });
  const ctx = harness(() => pending);
  const started = ctx.service.setCodexLocalAccessEnabled(true);
  assert.equal(ctx.checks.length, 0);
  resolve(state);
  assert.equal(await started, state);
  assert.equal(JSON.stringify(ctx.checks), JSON.stringify([{ running: true, restarted: true }]));
});
test('explicit restart and launch-preview activation prompt again; ordinary status reads do not', async () => {
  const ctx = harness(async () => state);
  await ctx.service.restartCodexLocalAccessSidecar();
  await ctx.service.getCodexLocalAccessState();
  await ctx.service.activateCodexLocalAccess();
  assert.equal(JSON.stringify(ctx.checks), JSON.stringify([{ running: true, restarted: true }, { running: true, restarted: true }]));
});
test('failed startup never prompts and stopping updates the run boundary', async () => {
  const failed = harness(async () => { throw new Error('startup failure'); });
  await assert.rejects(failed.service.setCodexLocalAccessEnabled(true), /startup failure/);
  assert.equal(failed.checks.length, 0);
  const stopped = harness(async () => ({ running: false, collection: { enabled: false } }));
  await stopped.service.setCodexLocalAccessEnabled(false);
  assert.equal(stopped.checks[0].running, false);
  assert.equal(stopped.checks[0].stopped, true);
});
test('instance gateway restarts never trigger the global API-service authorization guide', async () => {
  const ctx = harness(async () => state);
  await ctx.service.restartCodexInstanceGateway('instance', 'provider');
  assert.equal(ctx.checks.length, 0);
});

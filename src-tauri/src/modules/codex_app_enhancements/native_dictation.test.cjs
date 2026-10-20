const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const script = fs.readFileSync(path.join(__dirname, 'native_dictation.js'), 'utf8');
const moduleUrl = 'app://-/assets/app-initial-fixture.js';
const fixture = `
var kKt=Y(U,({get:e})=>{if(!navigator?.mediaDevices?.getUserMedia||typeof MediaRecorder>\`u\`)return{isLoading:!1,isError:!1,isCapable:!1};let t=e(ig,\`4100906017\`),n=e(rg,\`4100906017\`),{authLoading:r,authMethod:i}=e(Ag),a=r||t;return{isLoading:a,isError:!1,isCapable:!a&&n&&i===\`chatgpt\`}});
var MKt=Y(U,({get:e})=>e(ig,\`770071981\`)?{isLoading:!0,isError:!1,isCapable:!1}:e(rg,\`770071981\`)?SKt(e,[\`chatgpt.workspace.feature.dictation.access\`]):{isLoading:!1,isError:!1,isCapable:!0});
var definitions={dictation:{accessPolicy:\`workspace-dictation\`,configFeatures:[{key:\`in_app_dictation\`,host:\`default\`,clients:[\`electron\`,\`extension\`]}],supportedClients:[\`browser\`,\`chrome-extension\`,\`electron\`,\`extension\`],children:{}}};
var zKt={dictation:kKt,'workspace-dictation':MKt},ty=wc(U,(e,{get:t})=>{let n={accessPolicies:['workspace-dictation','dictation'],configFeatures:definitions.dictation.configFeatures};
let r=[...n.accessPolicies.map(e=>{let n=zKt[e];return n==null?{isLoading:!1,isError:!0,isCapable:!1}:t(n)}),...policySettings(),...n.configFeatures.map(n=>{if(n.clients?.includes(\`electron\`)===!1)return{isLoading:!1,isError:!1,isCapable:!0};n.host;let r=n.host==="default"?Ls:e.hostId;if(r==null)throw Error(\`Explicit-host capability requires hostId: \${e.name}\`);let i=t(Jh,r),a=i.isError,o=i.isLoading||!a&&i.data==null,s=i.data?.find(e=>e.name===n.key);return{isLoading:o,isError:a,isCapable:!o&&!a&&s?.enabled!==!1}})];
return r.length===0?{isLoading:!1,isError:!1,isCapable:!0}:{isLoading:r.some(e=>e.isLoading),isError:r.some(e=>e.isError),isCapable:r.every(e=>e.isCapable)}},{isEqual:JKt});
function JKt(e,t){return e.isLoading===t.isLoading&&e.isError===t.isError&&e.isCapable===t.isCapable}
function l6u(e){let t=(0,u6u.c)(2),n=e!==void 0&&e?\`dictation.chatgpt\`:\`dictation.composer\`,r;t[0]===n?r=t[1]:(r={name:n},t[0]=n,t[1]=r);let i=Eu(ty,r);return i.isLoading?null:i.isCapable}
function Cbd(e){let {sourceComposerScope:n,chatgpt:r,conversationId:i,executionTargetHostId:a,isComposerInputVisible:o,isDictationEnabled:s,productSurface:c,onDictationTranscriptInsert:p}=e;
let I=Eu(xUt,r!=null)&&p!=null,L;
let R=abd(L),z=l6u(r!=null),B=s&&z===!0,V=o&&B;
let {result}=W3u({chatgpt:r,enabled:B,productSurface:c,onTranscriptInsert:p});
return {...result,capability:z,enabled:B,presentation:I};}
function W3u(e){let n=Eu(xUt,e.chatgpt!=null),r;
r={...e,cleanupEnabled:!1,dictationAudio:Oi?.dictationAudio,streamingEnabled:n};return {result:G3u(r)};}
function G3u(e){let t=[],E=undefined;
let {chatgpt:n,onTranscriptStart:u,onTranscriptUpdate:d,onTranscriptCancel:f,onTranscriptInsert:p}=e;
let je=()=>({chatgpt:n,onTranscriptStart:u,onTranscriptUpdate:d,onTranscriptCancel:f,onTranscriptInsert:p,onTranscriptRetry:undefined});
let Me=fu(je),Ne;t[25]===E;
let Ee={current:null};return {streaming:e.streamingEnabled,record(){Ee.current=Me();return Ee.current},async stop(n,i){
let c=Ee.current!=null&&(Oq()||Ee.current.chatgpt!=null)?Ee.current:Me();
if(c.chatgpt!=null)return XLo(n,{signal:i.abortController.signal,language:i.language});
return YLo(n,{signal:i.abortController.signal,language:i.language})}};}
async function YLo(e,t={}){nativeCalls.push({blob:e,options:t,kind:'local'});return {text:'native local'};}
async function XLo(e,t){nativeCalls.push({blob:e,options:t,kind:'chatgpt'});return {text:'native chatgpt'};}
`;

function load({ enabled = true, ready = true, apiKeyAuthVerified = false } = {}) {
  const calls = [], nativeCalls = [];
  const policy = { authMethod: 'apiKey', authLoading: false, rollout: true, rolloutLoading: false,
    workspaceRollout: true, workspaceRolloutLoading: false,
    workspace: { isLoading: false, isError: false, isCapable: true },
    configFeatures: { isLoading: false, isError: false, data: [{ name: 'in_app_dictation', enabled: true }] },
    settings: { isLoading: false, isError: false, isCapable: true } };
  const ig = {}, rg = {}, Ag = {}, Jh = {};
  const sandbox = {
    module: { exports: {} }, URL, DOMException, Reflect, Object,
    __cockpitEnhancements: { apiDictation: enabled, apiKeyAuthVerified },
    __cockpitApiDictation: {
      ready, session: 'session-1',
      async transcribe(blob, options) { calls.push({ blob, options }); return { text: 'API transcript' }; },
    },
    nativeCalls, U: {}, ig, rg, Ag, Jh, Ls: 'local', policy,
    navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: class {},
    policySettings: () => [policy.settings],
    Y: (_scope, read) => read, wc: (_scope, read) => ({ read }),
    u6u: { c: () => [] }, xUt: {}, abd: () => null,
    Oi: {}, fu: value => value, Oq: () => false,
    SKt: () => policy.workspace,
  };
  const get = (atom, key) => {
    if (atom === ig) return key === '770071981' ? policy.workspaceRolloutLoading : policy.rolloutLoading;
    if (atom === rg) return key === '770071981' ? policy.workspaceRollout : policy.rollout;
    if (atom === Ag) return policy;
    if (atom === Jh) return policy.configFeatures;
    if (atom === 'workspace') return policy.workspace;
    if (typeof atom === 'function') return atom({ get });
    throw new Error('unexpected native policy');
  };
  sandbox.Eu = (selector, argument) => selector === sandbox.ty ? selector.read(argument, { get }) : true;
  sandbox.readPolicy = get;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, api: sandbox.module.exports, calls, nativeCalls, policy };
}

function evaluate(options) {
  const result = load(options);
  const transformed = result.api.transform(fixture, moduleUrl);
  assert.equal(transformed.ok, true, JSON.stringify(transformed.diagnostics));
  vm.runInContext(transformed.patchedSource, result.sandbox);
  return result;
}

function composer(sandbox, host = 'local', chatgpt = null, enabled = true) {
  return sandbox.Cbd({ executionTargetHostId: host, chatgpt,
    isDictationEnabled: enabled, isComposerInputVisible: true,
    onDictationTranscriptInsert() {} });
}

test('local API uses the official pipeline with matching non-streaming presentation', async () => {
  const { sandbox, calls, nativeCalls } = evaluate();
  const controller = composer(sandbox);
  assert.equal(controller.capability, true);
  assert.equal(controller.enabled, true);
  assert.equal(controller.presentation, false);
  assert.equal(controller.streaming, false);
  const handlers = controller.record();
  assert.equal(typeof handlers.onTranscriptInsert, 'function');
  const abortController = new AbortController();
  const blob = new Blob(['test'], { type: 'audio/webm' });
  assert.equal((await controller.stop(blob, { abortController, language: 'zh' })).text, 'API transcript');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].blob, blob);
  assert.equal(calls[0].options.signal, abortController.signal);
  assert.equal(calls[0].options.language, 'zh');
  assert.equal(nativeCalls.length, 0);
  assert.equal(composer(sandbox, 'local', null, false).enabled, false);
});

test('remote, ChatGPT and global dictation preserve their native paths', async () => {
  const { sandbox, api, calls, nativeCalls } = evaluate();
  const controllers = [composer(sandbox, 'remote-host'), composer(sandbox, 'local', {}), sandbox.G3u({})];
  for (const controller of controllers) {
    controller.record();
    await controller.stop(new Blob(['test']), { abortController: new AbortController() });
  }
  assert.deepEqual(nativeCalls.map(call => call.kind), ['local', 'chatgpt', 'local']);
  assert.equal(calls.length, 0);
  assert.equal(controllers[0].capability, false);
  assert.equal(controllers[0].presentation, true);
  assert.equal(controllers[0].streaming, true);
  assert.equal(controllers[1].capability, false);
  for (const host of [undefined, null, '', 'LOCAL', 'remote-host']) assert.equal(api.allowed(host), false);
  const args = { name: 'dictation.composer' };
  assert.equal(api.capabilityArgs(args, 'remote-host', false), args);
  assert.equal(api.capabilityArgs(args, 'local', true), args);
});

test('bridge readiness enables capability on the next ordinary native render', () => {
  const { sandbox, api } = evaluate({ ready: false });
  assert.equal(api.allowed('local'), false);
  assert.equal(composer(sandbox).capability, false);
  sandbox.__cockpitApiDictation.ready = true;
  assert.equal(composer(sandbox).capability, true);
  // No hook is inserted to force an update; native render timing is preserved.
  sandbox.__cockpitEnhancements.apiDictation = false;
  assert.equal(composer(sandbox).capability, false);
  assert.equal(composer(sandbox).streaming, true);
  assert.equal(composer(sandbox).presentation, true);
});

test('pure API eligibility preserves local disablement, browser support and auth loading', () => {
  const cases = [
    [state => { state.policy.settings.isCapable = false; }, false],
    [state => { state.policy.settings = { isLoading: false, isError: true, isCapable: false }; }, false],
    [state => { state.policy.settings = { isLoading: true, isError: false, isCapable: false }; }, null],
    [state => { state.policy.configFeatures.data[0].enabled = false; }, false],
    [state => { state.policy.configFeatures = { isLoading: true, isError: false }; }, null],
    [state => { state.policy.configFeatures = { isLoading: false, isError: true }; }, false],
    [state => { state.sandbox.navigator = {}; }, false],
    [state => { state.sandbox.MediaRecorder = undefined; }, false],
    [state => { state.policy.authLoading = true; }, null],
    [state => { state.policy.authMethod = null; }, false],
    [state => { state.policy.authMethod = 'personalAccessToken'; }, false],
  ];
  for (const [mutate, expected] of cases) {
    const state = evaluate();
    mutate(state);
    assert.equal(composer(state.sandbox).capability, expected);
    assert.equal(composer(state.sandbox).enabled, false);
  }
  for (const authMethod of ['chatgpt', 'apiKey', 'apikey']) {
    const state = evaluate();
    state.policy.authMethod = authMethod;
    assert.equal(composer(state.sandbox).capability, true);
    state.policy.settings.isCapable = false;
    assert.equal(composer(state.sandbox).capability, false);
  }
});

test('pure API does not depend on ChatGPT rollout or workspace entitlements', () => {
  for (const authMethod of ['apiKey', 'apikey']) {
    for (const mutate of [
      state => { state.policy.rollout = false; },
      state => { state.policy.rolloutLoading = true; },
      state => { state.policy.workspace.isCapable = false; },
      state => { state.policy.workspace = { isLoading: false, isError: true, isCapable: false }; },
      state => { state.policy.workspace = { isLoading: true, isError: false, isCapable: false }; },
      state => { state.policy.workspaceRolloutLoading = true; },
    ]) {
      const state = evaluate();
      state.policy.authMethod = authMethod;
      mutate(state);
      assert.equal(composer(state.sandbox).capability, true);
      assert.equal(composer(state.sandbox).enabled, true);
      // The default native local setting is enabled unless explicitly false.
      state.policy.configFeatures.data = [];
      assert.equal(composer(state.sandbox).enabled, true);
      state.policy.configFeatures.data = [{ name: 'in_app_dictation', enabled: false }];
      assert.equal(composer(state.sandbox).enabled, false);
    }
  }
});

test('ChatGPT and non-local scopes retain native rollout and workspace policies', () => {
  for (const mutate of [
    state => { state.policy.rollout = false; },
    state => { state.policy.rolloutLoading = true; },
    state => { state.policy.workspace.isCapable = false; },
    state => { state.policy.workspaceRolloutLoading = true; },
  ]) {
    const state = evaluate();
    state.policy.authMethod = 'chatgpt';
    mutate(state);
    for (const controller of [composer(state.sandbox), composer(state.sandbox, 'remote-host'),
      composer(state.sandbox, 'local', {})]) assert.equal(controller.enabled, false);
  }
  const { api } = evaluate();
  const descriptor = { name: 'dictation.composer', hostId: 'local', cockpitApiDictation: true };
  for (const args of [{ ...descriptor, hostId: 'remote-host' },
    { ...descriptor, name: 'dictation.global' }, { ...descriptor, name: 'dictation.chatgpt' }]) {
    assert.equal(api.policyOverride(args, 'dictation', { authMethod: 'apiKey' }), null);
  }
  for (const policy of ['chatgpt-dictation', 'global-dictation', 'other']) {
    assert.equal(api.policyOverride(descriptor, policy, { authMethod: 'apiKey' }), null);
  }
});

test('verified local API provider accepts the native no-account authentication shape', () => {
  const state = evaluate({ apiKeyAuthVerified: true });
  Object.assign(state.policy, {
    authMethod: null, requiresAuth: false, authLoading: false,
    rollout: false, rolloutLoading: true, workspaceRolloutLoading: true,
    workspace: { isLoading: false, isError: true, isCapable: false },
  });
  assert.equal(composer(state.sandbox).enabled, true);
  state.policy.authLoading = true;
  assert.equal(composer(state.sandbox).capability, null);
  state.policy.authLoading = false;
  state.policy.configFeatures.data[0].enabled = false;
  assert.equal(composer(state.sandbox).enabled, false);
});

test('native null account alone never qualifies as an API profile', () => {
  for (const options of [
    { apiKeyAuthVerified: false },
    { apiKeyAuthVerified: true, ready: false },
    { apiKeyAuthVerified: true, enabled: false },
  ]) {
    const state = evaluate(options.enabled === false ? { apiKeyAuthVerified: true } : options);
    Object.assign(state.policy, { authMethod: null, requiresAuth: false, rollout: false });
    if (options.enabled === false) state.sandbox.__cockpitEnhancements.apiDictation = false;
    assert.equal(composer(state.sandbox).enabled, false);
  }
  for (const authMethod of [null, undefined, 'chatgpt', 'chatgptAuthTokens', 'personalAccessToken', 'copilot', 'amazonBedrock']) {
    const state = evaluate({ apiKeyAuthVerified: true });
    Object.assign(state.policy, { authMethod, requiresAuth: authMethod === null, rollout: false });
    assert.equal(composer(state.sandbox).enabled, false);
  }
  const state = evaluate({ apiKeyAuthVerified: true });
  Object.assign(state.policy, { authMethod: null, requiresAuth: false, rollout: false });
  assert.equal(composer(state.sandbox, 'remote-host').enabled, false);
  assert.equal(composer(state.sandbox, 'local', {}).enabled, false);
});

test('new capability parameter avoids pre-existing singleton and family caches', () => {
  const { sandbox, api } = evaluate({ ready: false });
  const args = { name: 'dictation.composer' };
  const key = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  const familyCache = new Map();
  const staleLeaf = { isLoading: false, isError: false, isCapable: false };
  let nativeLeafReads = 0;
  const read = descriptor => {
    const cacheKey = key(descriptor);
    if (!familyCache.has(cacheKey)) {
      familyCache.set(cacheKey, sandbox.ty.read(descriptor, { get(atom) {
        if (atom === sandbox.kKt) { nativeLeafReads++; return staleLeaf; }
        return sandbox.readPolicy(atom);
      } }));
    }
    return familyCache.get(cacheKey);
  };
  assert.equal(read(args).isCapable, false);
  assert.equal(nativeLeafReads, 1);
  sandbox.__cockpitApiDictation.ready = true;
  const compatible = api.capabilityArgs(args, 'local', false);
  assert.notEqual(key(compatible), key(args));
  assert.equal(api.capabilityArgs(args, 'local', false), compatible);
  assert.equal(read(compatible).isCapable, true);
  assert.equal(nativeLeafReads, 1, 'the compatible policy reads actual dependencies instead of stale kKt');
  assert.equal(read(args).isCapable, false, 'the original family cache remains intact');
  assert.equal(familyCache.size, 2);
});

test('policy revision and verification transitions do not reuse a stale family result', () => {
  const { sandbox, api, policy } = evaluate({ apiKeyAuthVerified: false });
  Object.assign(policy, { authMethod: null, requiresAuth: false, rollout: false });
  const args = { name: 'dictation.composer' };
  const key = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  const legacyArgs = { ...args, hostId: 'local', cockpitApiDictation: true };
  const cache = new Map([[key(legacyArgs), { isLoading: false, isError: false, isCapable: false }]]);
  let reads = 0;
  const read = descriptor => {
    const cacheKey = key(descriptor);
    if (!cache.has(cacheKey)) {
      reads++;
      cache.set(cacheKey, sandbox.ty.read(descriptor, { get: sandbox.readPolicy }));
    }
    return cache.get(cacheKey);
  };
  const unverified = api.capabilityArgs(args, 'local', false);
  assert.equal(unverified.cockpitApiDictationPolicyVersion, 2);
  assert.equal(unverified.cockpitApiAuthVerified, false);
  assert.notEqual(key(unverified), key(legacyArgs));
  assert.equal(read(unverified).isCapable, false);
  assert.equal(api.capabilityArgs(args, 'local', false), unverified);

  sandbox.__cockpitEnhancements.apiKeyAuthVerified = true;
  const verified = api.capabilityArgs(args, 'local', false);
  assert.notEqual(verified, unverified);
  assert.notEqual(key(verified), key(unverified));
  assert.equal(read(verified).isCapable, true);
  assert.equal(api.capabilityArgs(args, 'local', false), verified);
  assert.equal(read(legacyArgs).isCapable, false, 'a previously cached policy remains isolated');

  sandbox.__cockpitEnhancements.apiKeyAuthVerified = false;
  const revoked = api.capabilityArgs(args, 'local', false);
  assert.notEqual(revoked, verified);
  assert.equal(key(revoked), key(unverified));
  assert.equal(read(revoked).isCapable, false, 'revocation cannot retain verified eligibility');
  assert.equal(reads, 2, 'each verification state is evaluated once with its own native family key');
});

test('new verification keys preserve explicit local disablement and scope boundaries', () => {
  const { sandbox, api, policy } = evaluate({ apiKeyAuthVerified: false });
  Object.assign(policy, { authMethod: null, requiresAuth: false });
  policy.configFeatures.data[0].enabled = false;
  const args = { name: 'dictation.composer' };
  for (const verified of [false, true, false]) {
    sandbox.__cockpitEnhancements.apiKeyAuthVerified = verified;
    const local = api.capabilityArgs(args, 'local', false);
    assert.equal(local.cockpitApiAuthVerified, verified);
    assert.equal(sandbox.ty.read(local, { get: sandbox.readPolicy }).isCapable, false);
    assert.equal(api.capabilityArgs(args, 'remote-host', false), args);
    assert.equal(api.capabilityArgs(args, 'local', true), args);
  }
});

test('stable handlers preserve each recording snapshot across host and bridge changes', async () => {
  const { sandbox, api, calls, nativeCalls } = evaluate();
  const originalHandler = () => ({ onTranscriptInsert() {} });
  const first = api.scopedHandlers(originalHandler, 'local');
  const saved = first();
  assert.equal(api.scopedHandlers(originalHandler, 'remote-host'), first);
  assert.equal(first().cockpitDictationScope, null);
  assert.equal(saved.cockpitDictationScope.host, 'local');

  const controller = composer(sandbox);
  controller.record();
  sandbox.__cockpitApiDictation = { ready: true, session: 'session-2', transcribe: async () => ({ text: 'new transport' }) };
  await assert.rejects(() => controller.stop(new Blob(['test']), { abortController: new AbortController() }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  assert.equal(nativeCalls.length, 0);
});

test('stopping or disabling an admitted transport cannot fall back to official upload', async () => {
  for (const mutate of [
    sandbox => { sandbox.__cockpitApiDictation.ready = false; },
    sandbox => { sandbox.__cockpitApiDictation.session = 'replacement-session'; },
    sandbox => { sandbox.__cockpitEnhancements.apiDictation = false; },
    sandbox => { delete sandbox.__cockpitApiDictation; },
  ]) {
    const { sandbox, nativeCalls, calls } = evaluate();
    const controller = composer(sandbox);
    controller.record();
    mutate(sandbox);
    await assert.rejects(() => controller.stop(new Blob(['test']), { abortController: new AbortController() }), { name: 'AbortError' });
    assert.equal(nativeCalls.length, 0);
    assert.equal(calls.length, 0);
  }
});

test('cancel passes through the native signal and prevents stale transcription results', async () => {
  const { sandbox, calls, nativeCalls } = evaluate();
  const controller = composer(sandbox);
  controller.record();
  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(() => controller.stop(new Blob(['test']), { abortController }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  assert.equal(nativeCalls.length, 0);

  let finish;
  sandbox.__cockpitApiDictation.transcribe = (_blob, options) => new Promise(resolve => {
    assert.equal(options.signal, inFlight.signal);
    finish = resolve;
  });
  const inFlight = new AbortController();
  controller.record();
  const pending = controller.stop(new Blob(['test']), { abortController: inFlight });
  inFlight.abort();
  finish({ text: 'must not be inserted' });
  await assert.rejects(() => pending, { name: 'AbortError' });
});

test('replacement during response and malformed bridge responses fail without native fallback', async () => {
  const { sandbox, api, nativeCalls } = evaluate();
  const handler = api.scopedHandlers(() => ({}), 'local');
  let finish;
  sandbox.__cockpitApiDictation.transcribe = () => new Promise(resolve => { finish = resolve; });
  const pending = api.transcribe(handler().cockpitDictationScope, new Blob(['test']), {}, sandbox.YLo);
  sandbox.__cockpitApiDictation.session = 'new-session';
  finish({ text: 'stale' });
  await assert.rejects(() => pending, { name: 'AbortError' });
  sandbox.__cockpitApiDictation.transcribe = async () => ({ text: 123 });
  await assert.rejects(() => api.transcribe(handler().cockpitDictationScope, new Blob(['test']), {}, sandbox.YLo), { name: 'TypeError' });
  assert.equal(nativeCalls.length, 0);
});

test('all nine gates and surrounding contracts are required atomically', () => {
  const { api } = load();
  const result = api.transform(fixture, moduleUrl);
  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.diagnostics.gates).length, 9);
  assert.ok(Object.values(result.diagnostics.gates).every(value => value === 1));
  for (const source of [fixture + fixture, fixture.replace('executionTargetHostId:a', 'executionTargetHostId:other'),
    fixture.replace('let Me=fu(je),Ne;', 'let Me=other(je),Ne;'),
    fixture.replace('isCapable:!a&&n&&i===`chatgpt`', 'isCapable:!a&&n&&i===`chatgpt`&&newPolicy'),
    fixture.replace('return YLo(n,', 'return other(n,'), result.patchedSource.replace('cockpitDictationHost:r==null?a:null,', ''), 'unknown client']) {
    const unsupported = api.transform(source, moduleUrl);
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.patchedSource, source);
  }
  assert.equal(api.transform(result.patchedSource, moduleUrl).ok, true);
  assert.equal(api.transform(result.patchedSource, moduleUrl).patchedSource, result.patchedSource);
  // Exported HTTP helpers stay available to all other official callers.
  assert.equal(result.patchedSource.slice(result.patchedSource.indexOf('async function YLo')),
    fixture.slice(fixture.indexOf('async function YLo')));
});

test('unsupported URLs and disabled adaptation leave source untouched', () => {
  const { api } = load();
  for (const url of ['https://example.com/app-initial-a.js', 'app://remote/assets/app-initial-a.js',
    'app://-/assets/app-initial-a.js?secret=x', 'app://-/assets/app-primary-a.js',
    'file://remote/app-initial-a.js', 'invalid']) {
    assert.equal(api.transform(fixture, url).ok, false);
    assert.equal(api.transform(fixture, url).patchedSource, fixture);
  }
  const disabled = load({ enabled: false }).api.transform(fixture, moduleUrl);
  assert.equal(disabled.ok, false);
  assert.equal(disabled.patchedSource, fixture);
});

const actualFixture = process.env.COCKPIT_NATIVE_DICTATION_FIXTURE || process.env.COCKPIT_NATIVE_FAST_FIXTURE;
test('installed desktop artifact matches every gate and remains valid JavaScript', { skip: !actualFixture }, () => {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run with --experimental-vm-modules for the artifact check');
  const { api } = load();
  const source = fs.readFileSync(actualFixture, 'utf8');
  const transformed = api.transform(source, `app://-/assets/${path.basename(actualFixture)}`);
  assert.equal(transformed.ok, true, JSON.stringify(transformed.diagnostics));
  new vm.SourceTextModule(transformed.patchedSource);
  for (const token of ['.useState(', '.useRef(', '.useEffect(', '.useInsertionEffect(', '.useSyncExternalStore(', '.c(122)']) {
    assert.equal(transformed.patchedSource.split(token).length, source.split(token).length);
  }
});

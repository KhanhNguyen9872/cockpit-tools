const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { fixture } = require('./fast_fixture_current.cjs');

const script = fs.readFileSync(path.join(__dirname, 'fast.js'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname,
  '../../../../sidecars/cockpit-cliproxy/third_party/CLIProxyAPI/internal/registry/models/codex_client_models.json'), 'utf8'));
const fallbacks = Object.fromEntries(catalog.models.flatMap(model => {
  const tier = model.service_tiers?.find(tier => tier.id === 'ultrafast');
  return tier ? [[model.slug, tier]] : [];
}));

// Independently authored fixture of the native model query/selector contract.
const queryFixture = 'function modelQuery(host,auth,catalog){let scope={},limit=100,additional=[],daybreak=false,defaults={availableModels:[],defaultModel:null,useHiddenModels:false},efforts=[],ultra=true,custom=true;return{queryFn:()=>{let priority=`interactive`;return manager(scope,host).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:limit},{priority:priority})},select:({data:models})=>selectModels({additionalAvailableModels:new Set(additional),apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:defaults.availableModels,defaultModel:defaults.defaultModel,enabledReasoningEfforts:efforts,hasConfiguredModelCatalog:catalog,includeUltraReasoningEffort:ultra,isCustomModelProvider:custom,models:models,useHiddenModels:defaults.useHiddenModels})}}';

function load(settings = {}) {
  const sandbox = { module: { exports: {} }, URL, Blob, setTimeout, clearTimeout,
    __cockpitEnhancements: { nativeFast: true, serviceTierFallbacks: fallbacks, ...settings },
    selectModels: options => options.models };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  const api = sandbox.module.exports;
  const transformed = api.transform(fixture + '\n' + queryFixture);
  assert.equal(transformed.ok, true);
  assert.equal(transformed.diagnostics.modelCatalog, 1);
  vm.runInNewContext(transformed.patchedSource, sandbox);
  return { api, sandbox, select: (models, host = 'local', auth = 'apikey', configured = false) =>
    sandbox.modelQuery(host, auth, configured).select({ data: models }) };
}

function models() {
  return ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.5', 'codex-auto-review'].map(model => ({
    model, displayName: model, hidden: model === 'codex-auto-review',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'native description' }],
  }));
}

test('default API catalog gains supported Ultrafast without changing model order, visibility or native cache', () => {
  const env = load(), input = models(), before = JSON.stringify(input);
  const output = env.select(input);
  assert.deepEqual(Array.from(output, model => model.model), input.map(model => model.model));
  assert.equal(JSON.stringify(input), before);
  for (const [index, model] of output.entries()) {
    assert.equal(model.hidden, input[index].hidden);
    assert.equal(model.serviceTiers[0], input[index].serviceTiers[0]);
    if (index < 2) {
      assert.equal(model.serviceTiers[1].id, 'ultrafast');
      assert.equal(model.serviceTiers[1].description, '', 'use the official translation');
    } else assert.equal(model, input[index]);
  }
  assert.equal(env.select(output), output, 'repeated selection never duplicates a tier');
});

test('custom catalogs, unknown catalog state, remote hosts and non-API identities are preserved', () => {
  const env = load(), input = models();
  for (const configured of [true, null, undefined]) {
    assert.equal(env.api.modelsForSpeed(input, 'local', 'apikey', configured), input);
  }
  for (const auth of ['chatgpt', 'personalAccessToken', 'amazonBedrock', 'copilot', null, 'unknown']) {
    assert.equal(env.select(input, 'local', auth), input);
  }
  assert.equal(env.select(input, 'remote'), input);
  env.sandbox.__cockpitEnhancements.nativeFast = false;
  assert.equal(env.select(input), input);
});

test('missing auth requires host verification and retains the remote-host boundary', () => {
  const env = load({ apiKeyAuthVerified: true }), input = models();
  assert.equal(env.select(input, 'local', null)[0].serviceTiers[1].id, 'ultrafast');
  assert.equal(env.select(input, 'remote', null), input);
  env.sandbox.__cockpitEnhancements.apiKeyAuthVerified = false;
  assert.equal(env.select(input, 'local', null), input);
});

test('preserve existing tier metadata and models that do not advertise fast support', () => {
  const env = load(), input = models();
  input[0].serviceTiers.push({ id: 'ultrafast', name: 'Native', description: 'upstream text' });
  input[1].serviceTiers = [];
  assert.equal(env.select(input), input);
  delete input[1].serviceTiers;
  assert.equal(env.select(input), input);
});

test('model selector hook requires the adjacent model/list request and rejects duplicate matches', () => {
  const { api } = load();
  const unrelated = api.transform(fixture + '\n' + queryFixture.replace('`model/list`', '`thread/list`'));
  assert.equal(unrelated.ok, true);
  assert.equal(unrelated.diagnostics.modelCatalog, 0);
  const duplicate = fixture + '\n' + queryFixture + '\n' + queryFixture;
  assert.equal(api.transform(duplicate).ok, false);
  assert.equal(api.transform(duplicate).patchedSource, duplicate);
});

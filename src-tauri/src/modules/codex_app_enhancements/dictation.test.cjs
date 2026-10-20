const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, 'dictation.js'), 'utf8');

function install({ previous, autoAck = true, maxBytes = 1024, timeoutMs = 5000 } = {}) {
  const messages = [], events = new Map(), intervals = new Map(), timers = new Map();
  let id = 0, now = 100;
  const sandbox = { Blob, Uint8Array, DOMException, crypto: { randomUUID: () => `request-${++id}` },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    Date: { now: () => now }, location: { protocol: 'app:' }, __cockpitApiDictation: previous,
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    setInterval: (fn, delay) => { const key = ++id; intervals.set(key, { fn, delay }); return key; },
    clearInterval: key => intervals.delete(key),
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { fn, delay }); return key; },
    clearTimeout: key => timers.delete(key),
    bridge: value => {
      const message = JSON.parse(value); messages.push(message);
      if (autoAck && ['ready', 'alive'].includes(message.action))
        sandbox.__cockpitApiDictation.receive({ session: 'session', alive: true });
    },
  };
  sandbox.window = sandbox; sandbox.top = sandbox; sandbox.globalThis = sandbox;
  const config = { session: 'session', binding: 'bridge', maxBytes, timeoutMs,
    labels: { failed: 'localized failure', tooLarge: 'localized too large', timedOut: 'localized timeout', unsupported: 'localized unsupported' } };
  vm.runInNewContext(script.replace('__COCKPIT_DICTATION_CONFIG__', JSON.stringify(config)), sandbox);
  const api = sandbox.__cockpitApiDictation;
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
  return { sandbox, api, messages, events, intervals, timers, tick, setNow: value => { now = value; },
    reply: result => api.receive({ session: 'session', ...result }) };
}
const audio = () => new Blob(['native recorded audio'], { type: 'audio/webm;codecs=opus' });

test('transport has no DOM, media capture or editor API; waits for backend acknowledgement', async () => {
  const env = install({ autoAck: false });
  assert.equal(env.api.ready, false);
  await assert.rejects(env.api.transcribe(audio()), /localized failure/);
  assert.deepEqual(env.messages.map(value => value.action), ['ready']);
  env.reply({ alive: true }); assert.equal(env.api.ready, true);
  assert.equal(/createElement|getUserMedia|MediaRecorder|querySelector|appendText|ProseMirror/.test(script), false);
  env.api.dispose();
});

test('native callback gets a transcript object, same audio and language; no extra send', async () => {
  const env = install(), callbacks = [];
  const result = env.api.transcribe(audio(), { language: 'zh',
    onRequestStart: value => callbacks.push(['start', value]),
    onRequestSuccess: value => callbacks.push(['success', value]), });
  await env.tick();
  const request = env.messages.find(value => value.action === 'transcribe');
  assert.equal(Buffer.from(request.audio, 'base64').toString(), 'native recorded audio');
  assert.equal(request.language, 'zh');
  assert.equal(request.mime, 'audio/webm;codecs=opus');
  env.reply({ requestId: request.requestId, text: '  原生草稿  ' });
  assert.deepEqual({ ...await result }, { text: '原生草稿' });
  assert.deepEqual(callbacks.map(value => value[0]), ['start', 'success']);
  assert.equal(callbacks[1][1].transcriptLength, 4);
  assert.deepEqual(env.messages.map(value => value.action), ['ready', 'transcribe']);
  assert.equal(env.timers.size, 0); env.api.dispose();
});

test('native cancel aborts in-flight transport and ignores late results', async () => {
  const env = install(), controller = new AbortController();
  const promise = env.api.transcribe(audio(), { signal: controller.signal });
  const failure = assert.rejects(promise, error => error.name === 'AbortError');
  await env.tick();
  const request = env.messages.at(-1);
  controller.abort(); await failure;
  env.reply({ requestId: request.requestId, text: 'too late' });
  assert.deepEqual(env.messages.map(value => value.action), ['ready', 'transcribe', 'cancel']);
  assert.equal(env.timers.size, 0); env.api.dispose();
});

test('cancel during encoding and already-aborted input never upload audio', async () => {
  const env = install(), controller = new AbortController();
  const promise = env.api.transcribe(audio(), { signal: controller.signal });
  controller.abort(); await assert.rejects(promise, error => error.name === 'AbortError');
  await env.tick();
  await assert.rejects(env.api.transcribe(audio(), { signal: controller.signal }), error => error.name === 'AbortError');
  assert.deepEqual(env.messages.map(value => value.action), ['ready']); env.api.dispose();
});

test('native retry can resubmit audio after failure; credentials and upstream error never leak', async () => {
  const env = install();
  const first = env.api.transcribe(audio()); const failed = assert.rejects(first, /localized failure/);
  await env.tick(); env.reply({ requestId: env.messages.at(-1).requestId, error: 'private upstream body' }); await failed;
  const retry = env.api.transcribe(audio()); await env.tick();
  env.reply({ requestId: env.messages.at(-1).requestId, text: '重试成功' });
  assert.equal((await retry).text, '重试成功'); env.api.dispose();
});

test('malformed results, wrong sessions and concurrent requests do not complete current request', async () => {
  const env = install();
  const promise = env.api.transcribe(audio()); const failed = assert.rejects(promise, /localized failure/);
  await assert.rejects(env.api.transcribe(audio()), /localized failure/);
  await env.tick(); const id = env.messages.at(-1).requestId;
  env.api.receive({ session: 'other', requestId: id, text: 'wrong session' });
  env.reply({ requestId: 'other', text: 'wrong request' });
  assert.equal(env.timers.size, 1);
  env.reply({ requestId: id, text: '' }); await failed; env.api.dispose();
});

test('timeout cancels HTTP, and heartbeat loss disables and aborts pending transport', async () => {
  const env = install();
  const promise = env.api.transcribe(audio()); const failed = assert.rejects(promise, /localized timeout/);
  await env.tick(); [...env.timers.values()][0].fn(); await failed;
  assert.equal(env.messages.at(-1).action, 'cancel');
  const second = env.api.transcribe(audio()); const aborted = assert.rejects(second, error => error.name === 'AbortError');
  await env.tick(); env.sandbox.bridge = value => env.messages.push(JSON.parse(value));
  env.setNow(12000); [...env.intervals.values()][0].fn();
  assert.equal(env.api.ready, false);
  [...env.timers.values()].find(timer => timer.delay === 3000).fn(); await aborted;
  assert.equal(env.api.ready, false); assert.equal(env.intervals.size, 0);
  assert.equal(env.events.size, 0); assert.equal(env.sandbox.__cockpitApiDictation, undefined);
});

test('native audio types are bounded; disposing prior transport cleans legacy controls', async () => {
  let disposed = 0;
  const env = install({ previous: { dispose() { disposed++; } } });
  assert.equal(disposed, 1);
  await assert.rejects(env.api.transcribe(new Blob(['x'.repeat(1025)])), /too large/);
  await assert.rejects(env.api.transcribe(new Blob(['x'], { type: 'text/html' })), /unsupported/);
  const promise = env.api.transcribe(new Blob(['wav'], { type: 'audio/wav' }), { language: '' }); await env.tick();
  env.reply({ requestId: env.messages.at(-1).requestId, text: 'wav result' });
  assert.equal((await promise).text, 'wav result'); env.api.dispose();
});


test('wake from sleep probes and accepts a healthy backend without losing the transport', () => {
  const env = install(), bridge = env.api;
  env.setNow(60000); [...env.intervals.values()][0].fn();
  assert.equal(env.api.ready, true);
  assert.equal(env.sandbox.__cockpitApiDictation, bridge);
  assert.equal(env.timers.size, 0);
  env.api.dispose();
});

test('installing a new session cancels old work without settling the new request', async () => {
  const env = install(), old = env.api;
  const previous = old.transcribe(audio());
  const canceled = assert.rejects(previous, error => error.name === 'AbortError');
  await env.tick(); const oldRequest = env.messages.at(-1).requestId;
  env.sandbox.newBridge = value => {
    const message = JSON.parse(value); env.messages.push(message);
    if (message.action === 'ready')
      env.sandbox.__cockpitApiDictation.receive({ session: 'new-session', alive: true });
  };
  vm.runInNewContext(script.replace('__COCKPIT_DICTATION_CONFIG__', JSON.stringify({
    session: 'new-session', binding: 'newBridge', maxBytes: 1024, timeoutMs: 5000,
    labels: { failed: 'localized failure' },
  })), env.sandbox);
  await canceled;
  const current = env.sandbox.__cockpitApiDictation;
  assert.equal(old.ready, false); assert.equal(current.ready, true);
  assert.ok(env.messages.some(value => value.action === 'cancel' && value.session === 'session'));
  const next = current.transcribe(audio()); await env.tick();
  const nextId = env.messages.at(-1).requestId;
  current.receive({ session: 'session', requestId: oldRequest, text: 'old result' });
  old.receive({ session: 'session', requestId: oldRequest, text: 'old result' });
  assert.equal(env.timers.size, 1);
  current.receive({ session: 'new-session', requestId: nextId, text: 'new result' });
  assert.equal((await next).text, 'new result'); current.dispose();
});

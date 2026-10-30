import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppBackgroundStore } from './useAppBackgroundStore.ts';
import { DEFAULT_APP_BACKGROUND } from '../utils/appBackground.ts';
import type { AppBackgroundRecord } from '../services/appBackgroundService.ts';
import { deferred } from '../../tests/helpers/reactHookHarness.ts';

test('cold start is immediately usable and concurrent consumers share one local read', async () => {
  const reading = deferred<AppBackgroundRecord>();
  let reads = 0;
  const store = createAppBackgroundStore({ load: () => { reads++; return reading.promise; }, save: async () => {} });
  assert.equal(store.getState().record.settings.preset, 'default');
  const first = store.getState().load();
  assert.equal(store.getState().load(), first);
  assert.equal(reads, 1);
  reading.resolve({ settings: { ...DEFAULT_APP_BACKGROUND, preset: 'forest' }, image: null });
  await first;
  assert.equal(store.getState().record.settings.preset, 'forest');
  assert.equal(store.getState().loaded, true);
  await store.getState().load();
  assert.equal(reads, 1);
});

test('a failed local read can retry without overwriting the saved record', async () => {
  let fails = true;
  const store = createAppBackgroundStore({
    load: async () => { if (fails) throw new Error('disk'); return { settings: { ...DEFAULT_APP_BACKGROUND, preset: 'sand' }, image: null }; },
    save: async () => { throw new Error('must not write during load'); },
  });
  await store.getState().load();
  assert.equal(store.getState().error, true);
  assert.equal(store.getState().loaded, false);
  assert.equal(store.getState().loading, false);
  fails = false;
  await store.getState().load();
  assert.equal(store.getState().error, false);
  assert.equal(store.getState().record.settings.preset, 'sand');
});

test('selection is immediate, failed autosaves retain the disk record, and retry persists the visible image', async () => {
  const old = new Blob(['old']);
  const next = new Blob(['next']);
  let saved: AppBackgroundRecord = { settings: { ...DEFAULT_APP_BACKGROUND, preset: 'custom' }, image: old };
  let fails = true;
  let urlId = 0;
  const revoked: string[] = [];
  const storage = { load: async () => saved, save: async (value: AppBackgroundRecord) => { if (fails) throw new Error('quota'); saved = value; } };
  const urls = { create: () => `blob:${++urlId}`, revoke: (url: string) => revoked.push(url) };
  const store = createAppBackgroundStore(storage, urls);
  await store.getState().load();
  store.getState().update({ preset: 'custom' }, { image: next });
  assert.equal(store.getState().record.image, next, 'visible image changes before persistence');
  assert.equal(store.getState().imageUrl, 'blob:2');
  await store.getState().flush();
  assert.equal(saved.image, old, 'failed storage keeps the previous disk image');
  assert.equal(store.getState().saveError, true);
  assert.equal(store.getState().saving, false);
  assert.deepEqual(revoked, ['blob:1']);
  fails = false;
  store.getState().retrySave();
  await store.getState().flush();
  assert.equal(saved.image, next);
  assert.equal(store.getState().saveError, false);
  assert.equal(store.getState().imageUrl, 'blob:2', 'retry does not recreate the visible image');
  const restarted = createAppBackgroundStore(storage, urls);
  await restarted.getState().load();
  assert.equal(restarted.getState().record.image, next);
  store.getState().update(DEFAULT_APP_BACKGROUND, { image: null });
  assert.equal(store.getState().imageUrl, null, 'restore takes effect immediately');
  await store.getState().flush();
  assert.equal(saved.image, null);
  assert.equal(saved.settings.preset, 'default');
});

test('rapid selections serialize storage writes and the latest choice wins', async () => {
  const firstWrite = deferred<void>();
  const writes: AppBackgroundRecord[] = [];
  let saved: AppBackgroundRecord = { settings: DEFAULT_APP_BACKGROUND, image: null };
  const store = createAppBackgroundStore({
    load: async () => saved,
    save: async value => { writes.push(value); if (writes.length === 1) await firstWrite.promise; saved = value; },
  });
  await store.getState().load();
  store.getState().update({ preset: 'mist' });
  store.getState().update({ preset: 'forest' });
  store.getState().update({ preset: 'dusk' });
  assert.equal(writes.length, 1);
  assert.equal(store.getState().record.settings.preset, 'dusk');
  firstWrite.resolve(); await store.getState().flush();
  assert.deepEqual(writes.map(value => value.settings.preset), ['mist', 'dusk']);
  assert.equal(saved.settings.preset, 'dusk');
  assert.equal(store.getState().saving, false);
  assert.throws(() => store.getState().update({ preset: 'custom' }), /imageRead/);
});

test('slider changes render synchronously, coalesce disk writes, and reuse the image URL', async () => {
  const image = new Blob(['image']);
  const writes: AppBackgroundRecord[] = [];
  let urlsCreated = 0;
  const store = createAppBackgroundStore({
    load: async () => ({ settings: { ...DEFAULT_APP_BACKGROUND, preset: 'custom' }, image }),
    save: async value => { writes.push(value); },
  }, { create: () => `blob:${++urlsCreated}`, revoke: () => {} });
  await store.getState().load();
  for (let strength = 1; strength <= 100; strength++) {
    store.getState().update({ strength }, { debounce: true });
    assert.equal(store.getState().record.settings.strength, strength);
  }
  assert.equal(writes.length, 0);
  assert.equal(urlsCreated, 1);
  await store.getState().flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].settings.strength, 100);
});

test('restore during an in-flight image save cannot be overwritten by its old completion', async () => {
  const firstWrite = deferred<void>();
  let count = 0;
  let saved: AppBackgroundRecord = { settings: DEFAULT_APP_BACKGROUND, image: null };
  const store = createAppBackgroundStore({ load: async () => saved, save: async value => {
    if (++count === 1) await firstWrite.promise;
    saved = value;
  } }, { create: () => 'blob:photo', revoke: () => {} });
  await store.getState().load();
  store.getState().update({ preset: 'custom' }, { image: new Blob(['new']) });
  store.getState().update(DEFAULT_APP_BACKGROUND, { image: null });
  assert.equal(store.getState().record.settings.preset, 'default');
  firstWrite.resolve(); await store.getState().flush();
  assert.equal(saved.settings.preset, 'default');
  assert.equal(saved.image, null);
  assert.equal(store.getState().record.settings.preset, 'default');
});

test('slider persistence runs automatically after the brief debounce', async () => {
  const writes: AppBackgroundRecord[] = [];
  const store = createAppBackgroundStore({
    load: async () => ({ settings: DEFAULT_APP_BACKGROUND, image: null }),
    save: async value => { writes.push(value); },
  });
  await store.getState().load();
  store.getState().update({ preset: 'forest', strength: 65 }, { debounce: true });
  store.getState().update({ strength: 70 }, { debounce: true });
  assert.equal(writes.length, 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].settings.strength, 70);
  assert.equal(store.getState().saving, false);
});

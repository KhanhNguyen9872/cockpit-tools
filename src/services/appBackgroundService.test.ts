import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHookModule } from '../../tests/helpers/reactHookHarness.ts';
import { DEFAULT_APP_BACKGROUND } from '../utils/appBackground.ts';

function harness() {
  let record: unknown;
  let failWrite = false;
  let blocked = false;
  let hung = false;
  let closed = 0;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const revoked: string[] = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
    toBlob: (callback: (value: Blob) => void) => callback(new Blob(['resized'], { type: 'image/webp' })) };
  const db = {
    close() { closed++; },
    transaction() {
      const tx: any = {
        abort() { tx.onabort?.(); },
        objectStore() { return {
          get() {
            const request = { result: record };
            if (!hung) queueMicrotask(() => tx.oncomplete());
            return request;
          },
          put(value: unknown) {
            queueMicrotask(() => {
              if (failWrite) tx.abort();
              else { record = value; tx.oncomplete(); }
            });
            return {};
          },
        }; },
      };
      return tx;
    },
  };
  const module = loadHookModule(new URL('./appBackgroundService.ts', import.meta.url), {}, {
    Blob,
    indexedDB: { open() {
      const request: any = { result: db };
      queueMicrotask(() => blocked ? request.onblocked() : request.onsuccess());
      return request;
    } },
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    URL: { createObjectURL: () => 'blob:input', revokeObjectURL: (url: string) => revoked.push(url) },
    Image: class {
      naturalWidth = 6000;
      naturalHeight = 3000;
      onload?: () => void;
      set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
    },
    document: { createElement: () => canvas },
  }).exports;
  return { module, canvas, revoked, timers, closes: () => closed,
    block() { blocked = true; }, hang() { hung = true; }, fail(value: boolean) { failWrite = value; } };
}

test('local storage saves settings and image together; aborted writes preserve the previous record', async () => {
  const h = harness();
  const image = new Blob(['photo'], { type: 'image/png' });
  const original = { settings: { ...DEFAULT_APP_BACKGROUND, preset: 'custom' }, image };
  await h.module.saveAppBackground(original);
  assert.deepEqual({ ...await h.module.loadAppBackground() }, original);
  h.fail(true);
  await assert.rejects(h.module.saveAppBackground({ settings: DEFAULT_APP_BACKGROUND, image: null }), /storage/);
  assert.deepEqual({ ...await h.module.loadAppBackground() }, original);
  h.fail(false);
  await h.module.saveAppBackground({ settings: DEFAULT_APP_BACKGROUND, image: null });
  assert.deepEqual({ ...await h.module.loadAppBackground() }, { settings: DEFAULT_APP_BACKGROUND, image: null });
  assert.equal(h.timers.size, 0);
  assert.equal(h.closes(), 6);
});

test('blocked and unresponsive storage fail without leaving a transaction open', async () => {
  const blocked = harness(); blocked.block();
  await assert.rejects(blocked.module.loadAppBackground(), /storage/);
  assert.equal(blocked.timers.size, 0);
  const h = harness(); h.hang();
  const loading = h.module.loadAppBackground();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0]();
  await assert.rejects(loading, /storage/);
  assert.equal(h.closes(), 1);
  assert.equal(h.timers.size, 0);
});

test('image selection rejects unsupported and oversized files, downsamples and releases the source URL', async () => {
  const h = harness();
  await assert.rejects(h.module.prepareBackgroundImage({ type: 'image/svg+xml', size: 1 }), /imageType/);
  await assert.rejects(h.module.prepareBackgroundImage({ type: 'image/png', size: 10 * 1024 * 1024 + 1 }), /imageSize/);
  const blob = await h.module.prepareBackgroundImage({ type: 'image/jpeg', size: 2000 });
  assert.equal(blob.type, 'image/webp');
  assert.equal(h.canvas.width, 2560);
  assert.equal(h.canvas.height, 1280);
  assert.deepEqual(h.revoked, ['blob:input']);
  assert.equal(h.timers.size, 0);
});

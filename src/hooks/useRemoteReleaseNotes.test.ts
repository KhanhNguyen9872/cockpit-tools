import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, loadHookModule, settlePromises } from '../../tests/helpers/reactHookHarness';

function setup() {
  const calls: { version: string; request: ReturnType<typeof deferred<unknown>> }[] = [];
  const h = loadHookModule(new URL('./useRemoteReleaseData.ts', import.meta.url), {
    '../services/releaseNotesService': {
      fetchReleaseNotes(version: string) {
        const request = deferred<unknown>();
        calls.push({ version, request });
        return request.promise;
      },
    },
  });
  return { h, calls };
}

test('dialog opens immediately; remote clearing replaces previous notes on reopen', async () => {
  const { h, calls } = setup();
  let version: string | undefined = '1.3.75';
  let state = h.render(() => h.exports.useRemoteReleaseNotes(version));
  assert.equal(state.loading, true);
  assert.equal(state.data, null);
  calls[0].request.resolve({ release_notes: 'Withdraw this', release_notes_zh: '删除此条' });
  await settlePromises();
  assert.equal(h.flush().data.release_notes, 'Withdraw this');
  version = undefined; h.flush();
  version = '1.3.75'; state = h.flush();
  assert.equal(calls.length, 2);
  assert.equal(state.data, null);
  calls[1].request.resolve({ release_notes: '', release_notes_zh: '' });
  await settlePromises();
  assert.equal(h.flush().data.release_notes, '');
  h.unmount();
});

test('closing/changing version rejects old in-flight results', async () => {
  const { h, calls } = setup();
  let version: string | undefined = '1.3.75';
  h.render(() => h.exports.useRemoteReleaseNotes(version));
  version = undefined; h.flush();
  version = '1.3.76'; h.flush();
  calls[1].request.resolve({ release_notes: 'Current' });
  await settlePromises(); h.flush();
  calls[0].request.resolve({ release_notes: 'Withdrawn' });
  await settlePromises();
  assert.equal(h.flush().data.release_notes, 'Current');
  h.unmount();
});

test('failure keeps an error until retry, which clears it and can succeed', async () => {
  const { h, calls } = setup();
  h.render(() => h.exports.useRemoteReleaseNotes('1.3.75'));
  calls[0].request.reject('timeout');
  await settlePromises();
  let state = h.flush();
  assert.equal(state.error, 'timeout');
  assert.equal(state.data, null);
  state.reload(); state = h.flush();
  assert.equal(state.error, '');
  assert.equal(state.loading, true);
  calls[1].request.resolve({ release_notes: 'Refreshed' });
  await settlePromises();
  state = h.flush();
  assert.equal(state.error, '');
  assert.equal(state.data.release_notes, 'Refreshed');
  h.unmount();
});

test('locale changes cannot overwrite the active history with a late response', async () => {
  const calls: { locale: string; request: ReturnType<typeof deferred<unknown>> }[] = [];
  const h = loadHookModule(new URL('./useRemoteReleaseData.ts', import.meta.url), {
    '../services/releaseNotesService': { fetchReleaseHistory(locale: string) {
      const request = deferred<unknown>(); calls.push({ locale, request }); return request.promise;
    } },
  });
  let locale = 'zh-CN';
  h.render(() => h.exports.useRemoteReleaseHistory(true, locale));
  locale = 'en'; h.flush();
  calls[1].request.resolve([{ version: '1.3.75', added: ['Current'] }]);
  await settlePromises(); h.flush();
  calls[0].request.resolve([{ version: '1.3.75', added: ['旧条目'] }]);
  await settlePromises();
  assert.equal(h.flush().data[0].added[0], 'Current');
  h.unmount();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHookModule } from '../../../../tests/helpers/reactHookHarness';

function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
}
const t = (key: string) => key;

test('result footers edit the selected live account and reflect saved tags without changing the batch', async () => {
  const state = {
    accounts: [
      { id: 'one', tags: ['good'] },
      { id: 'two', tags: [' fast ', 'GOOD'] },
    ],
    async updateAccountTags(id: string, tags: string[]) {
      saved.push({ id, tags: Array.from(tags) });
      state.accounts = state.accounts.map((account) => account.id === id ? { ...account, tags } : account);
    },
  };
  const saved: { id: string; tags: string[] }[] = [];
  const batch = { id: 'batch', status: 'completed', items: [
    { id: 'result-one', accountId: 'one', accountEmail: 'one@example.com', status: 'completed' },
    { id: 'result-two', accountId: 'two', accountEmail: 'two@example.com', status: 'failed' },
    { id: 'deleted', accountId: 'deleted', status: 'completed' },
  ] };
  const batchBefore = JSON.stringify(batch);
  const h = loadHookModule(new URL('./PelicanResults.tsx', import.meta.url), {
    'react-i18next': { useTranslation: () => ({ t }) },
    'react-dom': { createPortal: (value: unknown) => value },
    '../../../stores/useCodexAccountStore': { useCodexAccountStore: (select: any) => select(state) },
    '../../../stores/useCodexPelicanStore': {},
    '../../../services/codexPelicanService': {},
    '../../../types/codexPelican': { isPelicanRunning: () => false },
    './PelicanAccountSummary': { PelicanPlanBadge: 'plan' },
    '../../TagEditModal': { TagEditModal: 'tag-editor' },
    '../../ModalErrorMessage': { ModalErrorMessage: 'error' },
  }, { window: { document: { body: {} } } });
  h.render(() => h.exports.PelicanResults({ batch, mask: (value: string) => `masked:${value}` }));
  const buttons = () => nodes(h.flush()).filter((node) => node.props.className === 'card-action-btn');
  const editor = () => nodes(h.flush()).find((node) => node.type === 'tag-editor');
  assert.equal(buttons().length, 2, 'deleted accounts do not offer an unusable edit action');
  assert.equal(editor(), undefined);
  buttons()[1].props.onClick();
  assert.equal(editor().props.resetKey, 'two');
  assert.deepEqual(Array.from(editor().props.initialTags), [' fast ', 'GOOD']);
  assert.deepEqual(Array.from(editor().props.availableTags), ['fast', 'good']);
  await editor().props.onSave(['fast', 'reviewed']);
  assert.deepEqual(saved, [{ id: 'two', tags: ['fast', 'reviewed'] }]);
  const tiles = nodes(h.flush()).filter((node) => node.type === 'article');
  assert.ok(nodes(tiles[1]).some((node) => node.props.className === 'tag-pill' && node.props.children === 'reviewed'));
  assert.ok(nodes(tiles[0]).some((node) => node.props.className === 'tag-pill' && node.props.children === 'good'));
  editor().props.onClose();
  assert.equal(editor(), undefined);
  assert.equal(JSON.stringify(batch), batchBefore);
  h.unmount();
});

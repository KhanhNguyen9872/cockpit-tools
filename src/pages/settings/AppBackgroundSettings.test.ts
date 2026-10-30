import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHookModule, settlePromises } from '../../../tests/helpers/reactHookHarness.ts';
import { DEFAULT_APP_BACKGROUND } from '../../utils/appBackground.ts';

function nodes(value: any): any[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children)];
}

test('background controls apply immediately, stay interactive while saving, and expose only restore in the footer', async () => {
  const updates: any[] = [];
  const nextUpdate = () => updates.shift().map((value: object) => ({ ...value }));
  let flushes = 0;
  const state = {
    record: { settings: { ...DEFAULT_APP_BACKGROUND, preset: 'mist' }, image: null as Blob | null },
    imageUrl: null, loaded: true, loading: false, saving: true, error: false, saveError: false,
    load: async () => {}, flush: async () => { flushes++; }, retrySave: () => {},
    update: (...args: any[]) => { updates.push(args); },
  };
  const module = loadHookModule(new URL('./AppBackgroundSettings.tsx', import.meta.url), {
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    '../../stores/useAppBackgroundStore': { useAppBackgroundStore: () => state },
    '../../components/AppBackground': { BackgroundSurface: () => null },
    '../../components/SingleSelectDropdown': { SingleSelectDropdown: () => null },
    '../../services/appBackgroundService': { prepareBackgroundImage: async () => new Blob(['photo']) },
  });
  const tree = nodes(module.render(() => module.exports.AppBackgroundSettings()));
  assert.equal(tree.find(node => node.type === 'fieldset').props.disabled, false);
  const footer = tree.find(node => node.props.className === 'background-settings-actions');
  const actions = nodes(footer).filter(node => node.type === 'button');
  assert.equal(actions.length, 1);
  assert.ok(JSON.stringify(actions[0]).includes('settings.background.restore'));
  assert.ok(!JSON.stringify(tree).includes('settings.background.apply'));
  const preset = tree.find(node => node.type === 'button' && node.key === 'forest');
  preset.props.onClick();
  assert.deepEqual(nextUpdate(), [{ preset: 'forest' }, { debounce: false }]);
  const range = tree.find(node => node.type === 'input' && node.props.type === 'range');
  assert.equal(range.props.disabled, false);
  range.props.onChange({ target: { value: '80' } });
  assert.deepEqual(nextUpdate(), [{ strength: 80 }, { debounce: true }]);
  const file = tree.find(node => node.type === 'input' && node.props.type === 'file');
  let filePickerOpened = 0;
  file.props.ref.current = { click: () => { filePickerOpened++; } };
  const custom = tree.find(node => node.type === 'button' && node.key === 'custom');
  assert.match(custom.props.className, /background-preset-upload/);
  assert.ok(nodes(custom).some(node => node.props.className === 'background-preset-add' && node.props['aria-hidden'] === 'true'));
  assert.equal(custom.props.disabled, false, 'custom is clickable before an image exists');
  custom.props.onClick();
  assert.equal(filePickerOpened, 1);
  assert.equal(updates.length, 0, 'opening the picker does not apply an empty image');
  file.props.onChange({ target: { files: [], value: '' } });
  assert.equal(updates.length, 0, 'cancelling the picker preserves the current background');
  file.props.onChange({ target: { files: [{}], value: 'chosen' } });
  await settlePromises();
  const imageUpdate = updates.shift();
  assert.deepEqual({ ...imageUpdate[0] }, { preset: 'custom' });
  assert.ok(imageUpdate[1].image instanceof Blob);
  state.record.image = imageUpdate[1].image;
  const updatedTree = nodes(module.flush());
  const customWithImage = updatedTree.find(node => node.type === 'button' && node.key === 'custom');
  assert.ok(!nodes(customWithImage).some(node => node.props.className === 'background-preset-add'));
  updatedTree.find(node => node.type === 'button' && node.key === 'custom').props.onClick();
  assert.deepEqual(nextUpdate(), [{ preset: 'custom' }, { debounce: false }]);
  assert.equal(filePickerOpened, 1, 'existing custom image switches without reopening the picker');
  actions[0].props.onClick();
  assert.deepEqual(nextUpdate(), [DEFAULT_APP_BACKGROUND, { image: null }]);
  module.unmount();
  assert.equal(flushes, 1, 'leaving settings flushes a pending slider save');
});

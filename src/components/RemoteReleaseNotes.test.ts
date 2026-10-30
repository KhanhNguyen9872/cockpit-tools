import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHookModule } from '../../tests/helpers/reactHookHarness';

function content(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(content).join(' ');
  return content(node.props?.children);
}

for (const component of ['UpdateNotification', 'VersionJumpNotification']) {
  test(`${component} displays remote content and ignores cached installation notes`, () => {
    const versions: (string | undefined)[] = [];
    let remote = { release_notes: '### Added\n- Current remote entry', release_notes_zh: '' };
    const h = loadHookModule(new URL(`./${component}.tsx`, import.meta.url), {
      '../hooks/useRemoteReleaseData': { useRemoteReleaseNotes(version?: string) {
        versions.push(version);
        return { data: remote, loading: false, error: '', reload() {} };
      } },
      'react-i18next': { useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) },
      '../hooks/useEscClose': { useEscClose() {} },
      './RemoteReleaseStatus': { RemoteReleaseStatus: () => null },
      '@tauri-apps/plugin-opener': { openUrl() {} },
    }, { window: {}, performance: { now: () => 0 }, console: { log() {} } });
    const info = { latest_version: '1.3.75', current_version: '1.3.75', previous_version: '1.3.74', release_notes: 'Withdrawn cached entry' };
    let visible = true;
    let view = h.render(() => h.exports[component]({ info, updateInfo: info, visible, onClose() {} }));
    assert.match(content(view), /Current remote entry/);
    assert.doesNotMatch(content(view), /Withdrawn cached entry/);
    remote = { release_notes: '', release_notes_zh: '' };
    view = h.flush();
    assert.doesNotMatch(content(view), /Current remote entry|Withdrawn cached entry/);
    if (component === 'UpdateNotification') {
      visible = false; h.flush();
      assert.equal(versions[versions.length - 1], undefined);
      visible = true; h.flush();
      assert.equal(versions[versions.length - 1], '1.3.75');
    }
    h.unmount();
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUpdaterReleaseNotes } from '../src/utils/updaterReleaseNotes';

test('remote edits and cleared notes are preserved without built-in highlights', () => {
  const original = parseUpdaterReleaseNotes('## 更新日志（中文）\n### 新增\n- 删除此条\n## Changelog (English)\n### Added\n- Remove this');
  assert.match(original.releaseNotesZh, /删除此条/);
  const edited = parseUpdaterReleaseNotes('## 更新日志（中文）\n### 新增\n- 保留此条\n## Changelog (English)\n### Added\n- Keep this');
  assert.doesNotMatch(edited.releaseNotesZh, /删除此条/);
  assert.equal(edited.releaseNotes, '### Added\n- Keep this');
  assert.deepEqual(parseUpdaterReleaseNotes(''), { releaseNotes: '', releaseNotesZh: '' });
});

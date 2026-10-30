import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAntigravityModelOptions, getAntigravityModelDisplayName } from './antigravityModels.ts';
import { getDefaultGroups, getModelDisplayName } from './modelNames.ts';

test('new and old model versions remain separate selectable upstream IDs', () => {
  const ids = ['gemini-3-flash', 'gemini-3.8-flash-high', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'claude-sonnet-4-6', 'claude-sonnet-5-5-medium'];
  const result = filterAntigravityModelOptions(ids.map((id) => ({ id, displayName: '' })));
  assert.deepEqual(result.map((model) => model.id), ids);
  assert.notEqual(getAntigravityModelDisplayName('gemini-4-argon-medium'), getAntigravityModelDisplayName('gemini-4-argon-high'));
  assert.match(getModelDisplayName('claude-opus-4-6-thinking'), /Thinking/);
  assert.match(getAntigravityModelDisplayName('Unknown (Custom)'), /\(Custom\)/);
});

test('new grouping defaults add Argon and retain legacy groups', () => {
  const groups = getDefaultGroups();
  assert.ok(groups.some((group) => group.id === 'g3_pro'));
  assert.ok(groups.find((group) => group.id === 'g4_argon')?.desktopModels.includes('gemini-4-argon-high'));
  assert.ok(groups.find((group) => group.id === 'claude_45')?.desktopModels.includes('claude-sonnet-5-5-high'));
  assert.ok(groups.find((group) => group.id === 'g3_flash')?.desktopModels.includes('gemini-3.8-flash-high'));
});

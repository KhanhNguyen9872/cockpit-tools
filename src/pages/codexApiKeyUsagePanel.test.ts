import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import type { TFunction } from 'i18next';
import type { CodexAccount } from '../types/codex';
import type { ModelProviderUsageSummary } from '../services/modelProviderUsageService';
import { useCodexApiKeyUsageFormatting } from './codexApiKeyUsageFormatting';

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { renderCodexApiKeyUsagePanel, resolveCodexAccountDailyUsage } = await import('./codexApiKeyUsagePanel');
const t = ((key: string, fallback?: string) => fallback ?? key) as TFunction;
const account: CodexAccount = {
  id: 'test', email: 'test@example.com', auth_mode: 'apikey',
  openai_api_key: 'test-key', api_base_url: 'https://provider.example',
  tokens: { id_token: '', access_token: '' }, created_at: 0, last_used: 0,
};
function renderSummary(partial: Partial<ModelProviderUsageSummary>, variant: 'card' | 'table' = 'card') {
  const summary: ModelProviderUsageSummary = { mode: 'new_api', unit: 'USD', modelStatsCount: 0, latencyMs: 0, ...partial };
  function Panel() {
    const formatting = useCodexApiKeyUsageFormatting(t, String);
    return renderCodexApiKeyUsagePanel({
      account: partial.mode === 'openai_official' ? { ...account, api_base_url: 'https://api.openai.com/v1' } : account,
      provider: null, variant, usageState: { loading: false, summary }, t, ...formatting,
    });
  }
  return renderToStaticMarkup(createElement(Panel));
}
for (const variant of ['card', 'table'] as const) {
  test(`official API ${variant} keeps daily usage`, () => {
    const html = renderSummary({ mode: 'openai_official', todayCost: 12.5, todayRequests: 7, todayTotalTokens: 123, balance: 900 }, variant);
    for (const field of ['todayCost', 'todayRequests', 'todayTokens']) assert.ok(html.includes(`usage.fields.${field}`));
    assert.ok(html.includes('$12.50') && html.includes('>7<') && html.includes('>123<'));
    assert.ok(!html.includes('$900'));
  });
  test(`DeepSeek ${variant} shows its balance instead of daily cost`, () => {
    const html = renderSummary({ mode: 'deepseek', balance: 9.59, todayCost: 12.5 }, variant);
    assert.ok(html.includes('$9.59'));
    assert.ok(!html.includes('$12.50'));
  });
  test(`Sub2API ${variant} keeps its balance and request metrics`, () => {
    const html = renderSummary({ mode: 'sub2api', remaining: 80, todayRequests: 7, todayTotalTokens: 123 }, variant);
    assert.ok(html.includes('$80.00') && html.includes('>7<') && html.includes('>123<'));
  });
  test(`New API ${variant} shows its quota`, () => {
    const html = renderSummary({ mode: 'new_api', quotaLimit: 100, quotaRemaining: 80,
      details: [{ key: 'totalGranted', label: 'Granted', value: '100' }, { key: 'totalAvailable', label: 'Available', value: '80' }] }, variant);
    assert.ok(html.includes('$80.00') && html.includes('$100'));
  });
  test(`token plan ${variant} shows the remaining quota`, () => {
    const html = renderSummary({ mode: 'token_plan', remaining: 80, planName: 'Example' }, variant);
    assert.ok(html.includes('$80.00') && html.includes('Example'));
  });
}
test('official missing daily usage stays unknown', () => {
  const html = renderSummary({ mode: 'openai_official', balance: 40, totalCost: 120 });
  assert.equal((html.match(/<strong>—<\/strong>/g) ?? []).length, 3);
  assert.ok(!html.includes('$40.00'));
});
test('failed relay quota query shows an error instead of a blank panel', () => {
  function Panel() {
    const formatting = useCodexApiKeyUsageFormatting(t, String);
    return renderCodexApiKeyUsagePanel({
      account, provider: null, usageState: { loading: false, error: 'network error' }, t, ...formatting,
    });
  }
  assert.ok(renderToStaticMarkup(createElement(Panel)).includes('配额查询失败'));
});
test('APIKEY.FUN Anthropic account renders returned usage', () => {
  function Panel() {
    const formatting = useCodexApiKeyUsageFormatting(t, String);
    return renderCodexApiKeyUsagePanel({
      account: { ...account, api_base_url: 'https://api.apikey.fan', api_wire_api: 'anthropic' },
      provider: null, usageState: { loading: false, summary: { mode: 'sub2api', remaining: 80, todayRequests: 7, modelStatsCount: 0, latencyMs: 0 } }, t, ...formatting,
    });
  }
  const html = renderToStaticMarkup(createElement(Panel));
  assert.ok(html.includes('80') && html.includes('>7<'));
});
test('legacy Cockpit daily requests survive without treating total tokens as today usage', () => {
  const value = { ...account, quota: { raw_data: { usage: { stats: { requests: { today: 4, total: 50 }, tokens: { total: 10000 } } } } } } as CodexAccount;
  const summary = resolveCodexAccountDailyUsage(value);
  assert.equal(summary?.todayRequests, 4);
  assert.equal(summary?.todayTotalTokens, undefined);
  assert.equal(summary?.todayCost, undefined);
});

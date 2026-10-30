import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import type { CodexAccount } from '../types/codex';
import type { ModelProviderUsageSummary } from '../services/modelProviderUsageService';
import { useCodexApiKeyUsageFormatting } from './codexApiKeyUsageFormatting';
import { renderCodexApiKeyUsagePanel } from './codexApiKeyUsagePanel';

const t = ((key: string, fallback?: string) => fallback ?? key) as unknown as TFunction;
const account: CodexAccount = {
  id: 'test', email: 'test@example.com', auth_mode: 'apikey',
  openai_api_key: 'test-key', api_base_url: 'https://provider.example',
  tokens: { id_token: '', access_token: '' }, created_at: 0, last_used: 0,
};

function renderSummary(partial: Partial<ModelProviderUsageSummary>, variant: 'card' | 'table' = 'card') {
  const summary: ModelProviderUsageSummary = {
    mode: 'new_api', unit: '%', modelStatsCount: 0, latencyMs: 0, ...partial,
  };
  function Panel() {
    const formatting = useCodexApiKeyUsageFormatting(t, String);
    return renderCodexApiKeyUsagePanel({
      account, provider: null, variant, usageState: { loading: false, summary }, t, ...formatting,
    });
  }
  return renderToStaticMarkup(createElement(Panel));
}

for (const [name, partial, width] of [
  ['94 remaining of 100', { quotaLimit: 100, quotaRemaining: 94, quotaUsed: 6 }, 94],
  ['unused quota', { quotaLimit: 100, quotaRemaining: 100, quotaUsed: 0 }, 100],
  ['exhausted quota', { quotaLimit: 100, quotaRemaining: 0, quotaUsed: 100 }, 0],
  ['negative remaining', { quotaLimit: 100, quotaRemaining: -5 }, 0],
  ['remaining above total', { quotaLimit: 100, quotaRemaining: 105 }, 100],
  ['zero total', { quotaLimit: 0, quotaRemaining: 0 }, 0],
  ['negative total', { quotaLimit: -100, quotaRemaining: 50 }, 0],
  ['unknown quota', {}, 0],
  ['unknown remaining', { quotaLimit: 100 }, 0],
  ['non-finite quota', { quotaLimit: Infinity, quotaRemaining: NaN }, 0],
  ['unlimited quota', { quotaUnlimited: true }, 100],
  ['derived remaining', { quotaLimit: 100, quotaUsed: 6 }, 94],
  ['allocation details override summary', {
    quotaLimit: 100, quotaRemaining: 1,
    details: [{ key: 'totalGranted', label: 'Total', value: '200' }, { key: 'totalAvailable', label: 'Available', value: '150' }],
  }, 75],
] as Array<[string, Partial<ModelProviderUsageSummary>, number]>) {
  test(`New API card bar reflects remaining quota: ${name}`, () => {
    const html = renderSummary(partial);
    assert.match(html, new RegExp(`class="quota-bar high" style="width:${width}%"`));
    if (name === '94 remaining of 100') assert.match(html, /94% \/ 100%/);
    if (name === 'unlimited quota') assert.match(html, /不限量/);
  });
}

test('New API table keeps its existing used-percentage progress', () => {
  const html = renderSummary({ quotaLimit: 100, quotaRemaining: 94, quotaUsed: 6 }, 'table');
  assert.match(html, /class="cockpit-api-progress-bar" style="width:6%"/);
  assert.match(html, /<span>6%<\/span>/);
});

test('token plan card retains its existing progress calculation', () => {
  const html = renderSummary({ mode: 'token_plan', quotaLimit: 100, quotaRemaining: 94, quotaUsed: 6 });
  assert.match(html, /class="quota-bar high" style="width:6%"/);
});

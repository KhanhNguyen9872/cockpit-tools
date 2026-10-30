import type { CodexAccount } from '../types/codex';

export const OPENAI_OFFICIAL_USAGE_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_ADMIN_KEYS_URL = 'https://platform.openai.com/settings/organization/admin-keys';

export function resolveAccountUsageBaseUrl(
  account: Pick<CodexAccount, 'api_provider_mode' | 'api_base_url'>,
  providerBaseUrl?: string,
): string {
  return providerBaseUrl?.trim() || account.api_base_url?.trim() ||
    (account.api_provider_mode === 'openai_builtin' ? OPENAI_OFFICIAL_USAGE_BASE_URL : '');
}

export function isOpenAIOfficialUsageUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.openai.com' &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      ['', '/', '/v1', '/v1/'].includes(url.pathname);
  } catch {
    return false;
  }
}

export function isOpenAIOfficialUsageAccount(
  account: Pick<CodexAccount, 'api_provider_id' | 'api_provider_mode' | 'api_base_url'>,
  providerBaseUrl?: string,
): boolean {
  return account.api_provider_id !== 'cockpit_chatgpt_plan' &&
    isOpenAIOfficialUsageUrl(resolveAccountUsageBaseUrl(account, providerBaseUrl));
}

export function openAIUsageErrorKey(error: string): string {
  if (error.includes('OPENAI_USAGE_PERMISSION_REQUIRED')) return 'codex.openaiUsage.permissionRequired';
  if (error.includes('OPENAI_USAGE_INVALID_KEY')) return 'codex.openaiUsage.invalidKey';
  if (error.includes('OPENAI_USAGE_NETWORK_FAILED')) return 'codex.openaiUsage.networkFailed';
  return 'codex.openaiUsage.queryFailed';
}

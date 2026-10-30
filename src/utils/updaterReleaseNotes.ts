const ZH_SECTION_HEADER = '## 更新日志（中文）';
const EN_SECTION_HEADER = '## Changelog (English)';
const GITHUB_RELEASE_TAG_BASE_URL =
  'https://github.com/jlcodes99/cockpit-tools/releases/tag/v';
export interface ParsedUpdaterReleaseNotes {
  releaseNotes: string;
  releaseNotesZh: string;
}

function normalizeNotes(notes?: string): string {
  if (!notes) {
    return '';
  }
  return notes.replace(/\r\n/g, '\n').trim();
}

export function parseUpdaterReleaseNotes(notes?: string): ParsedUpdaterReleaseNotes {
  const normalized = normalizeNotes(notes);
  if (!normalized) {
    return {
      releaseNotes: '',
      releaseNotesZh: '',
    };
  }

  const zhIndex = normalized.indexOf(ZH_SECTION_HEADER);
  const enIndex = normalized.indexOf(EN_SECTION_HEADER);

  if (zhIndex >= 0 && enIndex >= 0) {
    if (zhIndex < enIndex) {
      return {
        releaseNotesZh: normalized
          .slice(zhIndex + ZH_SECTION_HEADER.length, enIndex)
          .trim(),
        releaseNotes: normalized.slice(enIndex + EN_SECTION_HEADER.length).trim(),
      };
    }

    return {
      releaseNotes: normalized
        .slice(enIndex + EN_SECTION_HEADER.length, zhIndex)
        .trim(),
      releaseNotesZh: normalized.slice(zhIndex + ZH_SECTION_HEADER.length).trim(),
    };
  }

  // 没有中英文分段时，直接复用同一份说明。
  return {
    releaseNotes: normalized,
    releaseNotesZh: normalized,
  };
}

function getStringFromRawJson(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed;
}

export function resolveUpdaterDownloadUrl(
  version: string,
  rawJson?: Record<string, unknown>,
): string {
  const raw = rawJson ?? {};
  const preferredKeys = ['html_url', 'download_url', 'url', 'details_url'];
  for (const key of preferredKeys) {
    const url = getStringFromRawJson(raw, key);
    if (url) {
      return url;
    }
  }

  const safeVersion = version.trim();
  if (!safeVersion) {
    return 'https://github.com/jlcodes99/cockpit-tools/releases/latest';
  }
  return `${GITHUB_RELEASE_TAG_BASE_URL}${encodeURIComponent(safeVersion)}`;
}

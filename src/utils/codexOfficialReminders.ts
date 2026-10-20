/** Local presentation preference only; never authorization or service membership. */
export const CODEX_OFFICIAL_REMINDERS_CHANGED = 'codex-official-reminders-changed';
export const CODEX_OFFICIAL_REMINDERS_KEY = 'codex.officialAuthorization.reminders.v1';
export interface CodexOfficialReminders { disabled: boolean; entrySeen: boolean }
const empty = (): CodexOfficialReminders => ({ disabled: false, entrySeen: false });
function decode(raw: string | null): CodexOfficialReminders {
  try {
    if (!raw) return empty();
    const value = JSON.parse(raw);
    // Retire per-account dismissals. Only the new global opt-out suppresses reminders.
    if (value?.version !== 1 && value?.version !== 2) return empty();
    return { disabled: value.version === 2 && value.disabled === true, entrySeen: value.entrySeen === true };
  } catch { return empty(); }
}
export function readCodexOfficialReminders(): CodexOfficialReminders {
  try { return decode(window.localStorage.getItem(CODEX_OFFICIAL_REMINDERS_KEY)); }
  catch { return empty(); }
}
function save(update: (current: CodexOfficialReminders) => CodexOfficialReminders): void {
  // A failed read/write never overwrites preferences or pretends a choice was saved.
  const next = update(decode(window.localStorage.getItem(CODEX_OFFICIAL_REMINDERS_KEY)));
  window.localStorage.setItem(CODEX_OFFICIAL_REMINDERS_KEY, JSON.stringify({ version: 2, ...next }));
  window.dispatchEvent(new Event(CODEX_OFFICIAL_REMINDERS_CHANGED));
}
export function setCodexOfficialRemindersEnabled(enabled: boolean): void {
  save((current) => ({ ...current, disabled: !enabled }));
}
export function areCodexOfficialRemindersEnabled(): boolean { return !readCodexOfficialReminders().disabled; }
export function markCodexOfficialEntrySeen(): void { save((current) => ({ ...current, entrySeen: true })); }

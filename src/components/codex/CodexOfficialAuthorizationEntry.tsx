import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { requestCodexOfficialAuthorizationManagement } from '../../utils/codexAccountServiceNavigation';
import { CODEX_OFFICIAL_REMINDERS_CHANGED, markCodexOfficialEntrySeen, readCodexOfficialReminders } from '../../utils/codexOfficialReminders';
import './CodexOfficialAuthorizationEntry.css';

/** Always available, even when every account recommendation was dismissed. */
export function CodexOfficialAuthorizationEntry({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const [seen, setSeen] = useState(() => readCodexOfficialReminders().entrySeen);
  useEffect(() => {
    const update = () => setSeen(readCodexOfficialReminders().entrySeen);
    window.addEventListener(CODEX_OFFICIAL_REMINDERS_CHANGED, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(CODEX_OFFICIAL_REMINDERS_CHANGED, update); window.removeEventListener('storage', update); };
  }, []);
  return <button type="button" className="btn btn-secondary codex-official-entry" disabled={disabled}
    title={t('chatgptPlan.officialFlow.entryHint')} onClick={() => {
      setSeen(true);
      try { markCodexOfficialEntrySeen(); } catch { /* The optional new badge never blocks access. */ }
      requestCodexOfficialAuthorizationManagement();
    }}>
    <span className="codex-official-entry-emblem"><ShieldCheck size={15} /><span>{t('chatgptPlan.officialFlow.badge')}</span></span>
    <span>{t('chatgptPlan.officialFlow.entry')}</span>
    {!seen && <span className="codex-official-entry-new">{t('chatgptPlan.officialFlow.newFeature')}</span>}
  </button>;
}

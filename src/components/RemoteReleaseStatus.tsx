import { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './RemoteReleaseStatus.css';

interface Props {
  loading: boolean;
  error: string;
  empty: boolean;
  onRetry: () => void;
}

export function RemoteReleaseStatus({ loading, error, empty, onRetry }: Props) {
  const { t } = useTranslation();
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  if (loading) {
    return <div className="release-notes-status" role="status">
      <RefreshCw size={14} className="spin" />
      {t('settings.about.releaseHistoryLoading')}
    </div>;
  }
  if (error) {
    return <div ref={errorRef} className="release-notes-status" role="alert">
      <span>{t('settings.about.releaseHistoryLoadFailed', { error })}</span>
      <button className="btn btn-secondary" onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>;
  }
  return empty ? <div className="release-notes-status" role="status">
    {t('settings.about.releaseHistoryEmpty')}
  </div> : null;
}

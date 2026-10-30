import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchReleaseHistory,
  fetchReleaseNotes,
} from '../services/releaseNotesService';

/** Refetch on each open/target change; late responses cannot restore withdrawn notes. */
export function useRemoteReleaseData<T>(key: string | null, load: () => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [state, setState] = useState<{
    key: string | null;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ key: null, data: null, loading: false, error: '' });

  useEffect(() => {
    const request = ++generation.current;
    setState({ key, data: null, loading: key !== null, error: '' });
    if (key === null) return;

    void load().then(
      (data) => {
        if (generation.current === request) {
          setState({ key, data, loading: false, error: '' });
        }
      },
      (error: unknown) => {
        if (generation.current === request) {
          setState({ key, data: null, loading: false, error: String(error) });
        }
      },
    );
    return () => { generation.current += 1; };
  }, [key, load, revision]);

  const reload = useCallback(() => {
    generation.current += 1;
    setState((previous) => ({ ...previous, data: null, error: '', loading: previous.key !== null }));
    setRevision((value) => value + 1);
  }, []);
  return {
    data: state.key === key ? state.data : null,
    loading: key !== null && (state.key !== key || state.loading),
    error: state.key === key ? state.error : '',
    reload,
  };
}

export function useRemoteReleaseNotes(version?: string) {
  const load = useCallback(() => fetchReleaseNotes(version!), [version]);
  return useRemoteReleaseData(version || null, load);
}

export function useRemoteReleaseHistory(open: boolean, locale: string) {
  const load = useCallback(() => fetchReleaseHistory(locale), [locale]);
  return useRemoteReleaseData(open ? locale : null, load);
}

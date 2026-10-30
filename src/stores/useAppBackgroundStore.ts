import { create } from 'zustand';
import { DEFAULT_APP_BACKGROUND, normalizeAppBackground, type AppBackgroundSettings } from '../utils/appBackground';
import { loadAppBackground, saveAppBackground, type AppBackgroundRecord } from '../services/appBackgroundService';

interface BackgroundState {
  record: AppBackgroundRecord;
  imageUrl: string | null;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: boolean;
  saveError: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppBackgroundSettings>, options?: { image?: Blob | null; debounce?: boolean }) => void;
  flush: () => Promise<void>;
  retrySave: () => void;
}

export function createAppBackgroundStore(storage = { load: loadAppBackground, save: saveAppBackground },
  urls = { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url) }) {
  let loading: Promise<void> | null = null;
  let writing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let savedRevision = 0;
  return create<BackgroundState>((set, get) => {
    const apply = (record: AppBackgroundRecord) => {
      if (record.image === get().record.image) { set({ record }); return; }
      const imageUrl = record.image ? urls.create(record.image) : null;
      const previous = get().imageUrl;
      set({ record, imageUrl });
      if (previous) urls.revoke(previous);
    };
    const flush = (): Promise<void> => {
      clearTimeout(timer);
      if (writing) return writing;
      if (revision === savedRevision || get().saveError) return Promise.resolve();
      writing = (async () => {
        while (savedRevision < revision) {
          const version = revision;
          const record = get().record;
          try { await storage.save(record); }
          catch {
            // Keep the current preview; the last successful disk record remains intact.
            // A newer choice can still be saved if the earlier write failed.
            if (version !== revision) continue;
            set({ saveError: true });
            return;
          }
          savedRevision = version;
        }
      })().finally(() => {
        writing = null;
        const pending = savedRevision < revision && !get().saveError;
        set({ saving: pending });
        if (pending) timer = setTimeout(() => { void flush(); }, 200);
      });
      return writing;
    };
    return {
      record: { settings: { ...DEFAULT_APP_BACKGROUND }, image: null },
      imageUrl: null, loaded: false, loading: false, saving: false, error: false, saveError: false,
      load: () => {
        if (get().loaded) return Promise.resolve();
        if (loading) return loading;
        set({ loading: true, error: false });
        loading = storage.load().then(record => { apply(record); set({ loaded: true }); })
          .catch(() => { set({ error: true }); })
          .finally(() => { loading = null; set({ loading: false }); });
        return loading;
      },
      update: (patch, options = {}) => {
        if (!get().loaded) return;
        const next = {
          settings: normalizeAppBackground({ ...get().record.settings, ...patch }),
          image: options.image === undefined ? get().record.image : options.image,
        };
        if (next.settings.preset === 'custom' && !next.image) throw new Error('imageRead');
        revision++;
        apply(next);
        set({ saving: true, saveError: false });
        clearTimeout(timer);
        if (options.debounce) timer = setTimeout(() => { void flush(); }, 200);
        else void flush();
      },
      flush,
      retrySave: () => {
        if (savedRevision === revision) return;
        set({ saving: true, saveError: false }); void flush();
      },
    };
  });
}

export const useAppBackgroundStore = createAppBackgroundStore();

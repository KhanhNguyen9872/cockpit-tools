import { invoke } from '@tauri-apps/api/core';

export interface ReleaseNotes {
  release_notes: string;
  release_notes_zh: string;
}

export interface ReleaseHistoryItem {
  version: string;
  date: string;
  highlights: string[];
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
}

export const fetchReleaseNotes = (version: string) =>
  invoke<ReleaseNotes>('get_release_notes', { version });

export const fetchReleaseHistory = (locale: string) =>
  invoke<ReleaseHistoryItem[]>('get_release_history', { locale, limit: 30 });

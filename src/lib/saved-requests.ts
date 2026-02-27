import Conf from 'conf';
import type { RequestValues } from './executor.js';

export interface SavedRequest {
  id: string;
  name: string;
  endpointId: string;
  method: string;
  path: string;
  envName: string | null;
  values: RequestValues;
  bodyFieldValues: Record<string, string>;
  savedAt: number;
}

const store = new Conf<{ saved: SavedRequest[] }>({
  projectName: 'openapicmd-tui',
  configName: 'saved-requests',
  defaults: { saved: [] },
});

export function getSavedRequests(): SavedRequest[] {
  return store.get('saved');
}

export function saveRequest(entry: Omit<SavedRequest, 'id' | 'savedAt'>): void {
  const item: SavedRequest = {
    ...entry,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    savedAt: Date.now(),
  };
  store.set('saved', [item, ...store.get('saved')]);
}

export function deleteSavedRequest(id: string): void {
  store.set('saved', store.get('saved').filter((s) => s.id !== id));
}

export function renameSavedRequest(id: string, name: string): void {
  store.set('saved', store.get('saved').map((s) => (s.id === id ? { ...s, name } : s)));
}

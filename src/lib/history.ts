import Conf from 'conf';
import type { RequestValues } from './executor.js';

export interface HistoryEntry {
  id: string;
  timestamp: number;
  endpointId: string;
  method: string;
  path: string;
  envName: string | null;
  values: RequestValues;
  /** Flat dot-notation map of body fields for re-populating individual form inputs */
  bodyFieldValues: Record<string, string>;
  result: {
    status: number;
    statusText: string;
    durationMs: number;
    error?: string;
  };
}

const MAX_ENTRIES = 50;

const store = new Conf<{ history: HistoryEntry[] }>({
  projectName: 'openapicmd-tui',
  configName: 'history',
  defaults: { history: [] },
});

// Flatten a nested object to dot-notation Record<string, string>
function flattenObject(obj: unknown, prefix: string): Record<string, string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenObject(v, key));
    } else {
      result[key] = v === null || v === undefined ? '' :
        (typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  return result;
}

export function addToHistory(
  endpointId: string,
  method: string,
  path: string,
  envName: string | null,
  values: RequestValues,
  result: HistoryEntry['result']
): void {
  let bodyFieldValues: Record<string, string> = {};
  if (values.body?.trim()) {
    try {
      bodyFieldValues = flattenObject(JSON.parse(values.body) as unknown, '');
    } catch { /* ignore */ }
  }

  const entry: HistoryEntry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    endpointId,
    method,
    path,
    envName,
    values,
    bodyFieldValues,
    result,
  };

  const history = store.get('history');
  store.set('history', [entry, ...history].slice(0, MAX_ENTRIES));
}

export function getHistory(): HistoryEntry[] {
  return store.get('history');
}

export function removeFromHistory(id: string): void {
  store.set('history', store.get('history').filter((e) => e.id !== id));
}

export function clearHistory(): void {
  store.set('history', []);
}

export function relativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

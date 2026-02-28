import Conf from 'conf';
import type { FieldLookup } from './field-lookups.js';

const store = new Conf<{ saved: Record<string, FieldLookup> }>({
  projectName: 'openapicmd-tui',
  configName: 'saved-lookups',
  defaults: { saved: {} },
});

export function getSavedLookups(): Record<string, FieldLookup> {
  return store.get('saved');
}

export function saveLookup(name: string, lookup: FieldLookup): void {
  store.set('saved', { ...store.get('saved'), [name]: lookup });
}

export function removeSavedLookup(name: string): void {
  const next = { ...store.get('saved') };
  delete next[name];
  store.set('saved', next);
}

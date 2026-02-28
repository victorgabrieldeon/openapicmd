import Conf from 'conf';

export interface FieldLookup {
  endpointId: string;
  method: string;
  path: string;
  valuePath: string;                    // e.g. "fields[].id" or "[].uuid" for root arrays
  displayPaths?: string[];              // optional display columns e.g. ["fields[].nome", "fields[].status"]
  queryParams?: Record<string, string>; // static query params sent with lookup request
  body?: string;                        // static JSON body sent with lookup request
}

const store = new Conf<{ lookups: Record<string, FieldLookup> }>({
  projectName: 'openapicmd-tui',
  configName: 'field-lookups',
  defaults: { lookups: {} },
});

export function getFieldLookups(): Record<string, FieldLookup> {
  return store.get('lookups');
}

export function setFieldLookup(fieldName: string, lookup: FieldLookup): void {
  store.set('lookups', { ...store.get('lookups'), [fieldName]: lookup });
}

export function removeFieldLookup(fieldName: string): void {
  const next = { ...store.get('lookups') };
  delete next[fieldName];
  store.set('lookups', next);
}

/** Resolve a path like "fields[].id" against a response body and return all values as strings.
 *
 *  Path syntax:
 *   - "fields[].id"       → body.fields is array, collect .id from each element
 *   - "[].id"             → body itself is an array, collect .id from each element
 *   - "data.items[].uuid" → navigate data → items (array) → collect uuid
 *   - "nome"              → body.nome (single value, returns 1-element array)
 */
export function resolvePathArray(body: unknown, path: string): string[] {
  const parts = path.trim().split('.');
  let current: unknown[] = [body];

  for (const part of parts) {
    const isArr = part.endsWith('[]');
    const key = isArr ? part.slice(0, -2) : part;
    const next: unknown[] = [];

    for (const item of current) {
      // Navigate to key (skip if key is empty — means use item directly)
      let val: unknown;
      if (key === '') {
        val = item;
      } else {
        if (item === null || typeof item !== 'object') continue;
        val = (item as Record<string, unknown>)[key];
      }

      if (isArr) {
        // Expand: val must be an array
        if (Array.isArray(val)) next.push(...val);
      } else {
        if (val !== undefined) next.push(val);
      }
    }

    current = next;
  }

  return current
    .filter((v) => v !== null && v !== undefined)
    .map((v) => (typeof v === 'string' ? v : String(v)));
}

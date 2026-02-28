import Conf from 'conf';

const store = new Conf<{ patterns: Record<string, string> }>({
  projectName: 'openapicmd-tui',
  configName: 'field-patterns',
  defaults: { patterns: {} },
});

/** fieldName → FAKER_ENTRIES id  (e.g. "documentoCredor" → "cpf_raw") */
export function getFieldPatterns(): Record<string, string> {
  return store.get('patterns');
}

export function setFieldPattern(fieldName: string, fakerId: string): void {
  store.set('patterns', { ...store.get('patterns'), [fieldName]: fakerId });
}

export function removeFieldPattern(fieldName: string): void {
  const next = { ...store.get('patterns') };
  delete next[fieldName];
  store.set('patterns', next);
}

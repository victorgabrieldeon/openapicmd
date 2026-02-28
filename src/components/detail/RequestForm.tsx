import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Endpoint } from '../../types/openapi.js';
import type { Environment } from '../../types/config.js';
import type { RequestValues } from '../../lib/executor.js';
import { useRequest } from '../../hooks/useRequest.js';
import { ResponseView } from './ResponseView.js';
import { JsonTree } from './JsonTree.js';
import { hasTokenCached } from '../../lib/executor.js';
import { useApp, useActiveEnvironment } from '../../context/AppContext.js';
import { saveRequest } from '../../lib/saved-requests.js';
import { FAKER_ENTRIES, suggestFakerForField } from '../../lib/faker.js';
import { parseCurl, extractPathParams } from '../../lib/curl-parser.js';
import { getPastParamValues } from '../../lib/history.js';
import { getFieldPatterns, setFieldPattern, removeFieldPattern } from '../../lib/field-patterns.js';
import { getFieldLookups, setFieldLookup, removeFieldLookup, resolvePathArray, type FieldLookup } from '../../lib/field-lookups.js';
import { getSavedLookups, saveLookup, removeSavedLookup } from '../../lib/saved-lookups.js';
import { executeRequest } from '../../lib/executor.js';

interface RequestFormProps {
  endpoint: Endpoint;
  env: Environment | null;
  fallbackBaseUrl?: string;
  onClose: () => void;
  height: number;
}

// ── Body field definitions ─────────────────────────────────────────────────
type BodyFieldDef = {
  label: string;
  fullKey: string;       // dot-notation: "credor.documentoCredor"
  type: string;
  required: boolean;
  description?: string;
  indent: number;
  isGroupHeader: boolean; // object/array section header — no input, just label
  nullable: boolean;
  enumValues?: string[];  // enum constraint values
  format?: string;        // e.g. 'date-time', 'date', 'email'
  example?: unknown;      // from OpenAPI spec
};

function fieldType(schema: Record<string, unknown>): string {
  if (schema['oneOf']) {
    const nonNull = (schema['oneOf'] as Record<string, unknown>[]).find((v) => v['type'] !== 'null');
    return nonNull ? fieldType(nonNull) + '?' : 'any?';
  }
  if (schema['type'] === 'array') {
    const items = schema['items'] as Record<string, unknown> | undefined;
    return (items ? fieldType(items) : 'any') + '[]';
  }
  if (schema['type']) return schema['type'] as string;
  if (schema['$ref']) return ((schema['$ref'] as string).split('/').pop() ?? 'object');
  if (schema['allOf'] || schema['anyOf']) return 'object';
  return 'any';
}

function mergeAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema['allOf']) return schema;
  return (schema['allOf'] as Record<string, unknown>[]).reduce((acc, s) => {
    const merged = mergeAllOf(s);
    return {
      ...acc,
      properties: { ...(acc['properties'] as object ?? {}), ...(merged['properties'] as object ?? {}) },
      required: [...((acc['required'] as string[]) ?? []), ...((merged['required'] as string[]) ?? [])],
    };
  }, {} as Record<string, unknown>);
}

function extractBodyFields(
  schema: Record<string, unknown>,
  prefix = '',
  indent = 0,
  maxDepth = 2
): BodyFieldDef[] {
  const resolved = mergeAllOf(schema);
  const properties = resolved['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];

  const required = (resolved['required'] as string[]) ?? [];
  const fields: BodyFieldDef[] = [];

  for (const [name, fs] of Object.entries(properties)) {
    const fullKey = prefix ? `${prefix}.${name}` : name;
    const isRequired = required.includes(name);
    const type = fieldType(fs);
    const description = fs['description'] as string | undefined;

    // Resolve the "real" schema — unwrap nullable oneOf to get the inner type
    let baseSchema: Record<string, unknown> = fs;
    let nullable = Boolean(fs['nullable']);
    if (fs['oneOf']) {
      const arr = fs['oneOf'] as Record<string, unknown>[];
      nullable = nullable || arr.some((s) => s['type'] === 'null');
      const nonNull = arr.find((s) => s['type'] !== 'null');
      if (nonNull) baseSchema = nonNull;
    }

    const effectiveSchema = baseSchema['allOf'] ? mergeAllOf(baseSchema) : baseSchema;

    // Enum values (from direct enum or effectiveSchema)
    const rawEnum = (effectiveSchema['enum'] ?? fs['enum']) as unknown[] | undefined;
    const enumValues = rawEnum && rawEnum.length > 0 ? rawEnum.map(String) : undefined;

    // Format (date-time, date, email, etc.)
    const format = (effectiveSchema['format'] ?? fs['format']) as string | undefined;

    // Spec example value
    const example = effectiveSchema['example'] ?? fs['example'];

    const hasProps = Boolean(effectiveSchema['properties']) || Boolean(effectiveSchema['allOf']);
    const isObject = (effectiveSchema['type'] === 'object' || hasProps) && indent < maxDepth;

    if (isObject && hasProps) {
      // Group header — no input
      fields.push({ label: name, fullKey, type, required: isRequired, description, indent, isGroupHeader: true, nullable, enumValues, format });
      fields.push(...extractBodyFields(effectiveSchema, fullKey, indent + 1, maxDepth));
    } else {
      fields.push({ label: name, fullKey, type, required: isRequired, description, indent, isGroupHeader: false, nullable, enumValues, format, example });
    }
  }

  return fields;
}

// ── Serialise flat field values → nested JSON object ──────────────────────
function coerceValue(raw: string, type: string): unknown {
  if (raw === '') return undefined;
  if (raw === 'null') return null;
  const baseType = type.replace('?', '');
  if (baseType === 'number' || baseType === 'integer') { const n = Number(raw); return isNaN(n) ? raw : n; }
  if (baseType === 'boolean') return raw === 'true';
  if (type.endsWith('[]') || type === 'object' || type === 'any') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function isChildOfCollapsed(fullKey: string, collapsedGroups: Set<string>): boolean {
  for (const groupKey of collapsedGroups) {
    if (fullKey.startsWith(groupKey + '.')) return true;
  }
  return false;
}

function serializeBodyFields(fields: BodyFieldDef[], values: Record<string, string>, collapsedGroups: Set<string>): string {
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.isGroupHeader) continue;
    if (isChildOfCollapsed(f.fullKey, collapsedGroups)) continue;
    const coerced = coerceValue(values[f.fullKey] ?? '', f.type);
    if (coerced !== undefined) setNested(result, f.fullKey, coerced);
  }
  return Object.keys(result).length > 0 ? JSON.stringify(result) : '';
}

// ── Deserialise nested JSON object → flat field values (reverse of serialize) ──
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function deserializeBodyFields(fields: BodyFieldDef[], json: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const f of fields) {
    if (f.isGroupHeader) continue;
    const value = getNestedValue(json, f.fullKey);
    if (value === undefined || value === null) continue;
    result[f.fullKey] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return result;
}

// ── Default value for a field ──────────────────────────────────────────────
function defaultFieldValue(fs: Record<string, unknown>): string {
  if (fs['default'] !== undefined) return String(fs['default']);
  if (fs['example'] !== undefined) return String(fs['example']);
  if (fs['enum']) return String((fs['enum'] as unknown[])[0] ?? '');
  return '';
}

function buildInitialFieldValues(fields: BodyFieldDef[], schema: Record<string, unknown> | undefined): Record<string, string> {
  if (!schema) return {};
  const resolved = mergeAllOf(schema);
  const values: Record<string, string> = {};

  function walk(props: Record<string, Record<string, unknown>>, prefix: string) {
    for (const [name, fs] of Object.entries(props)) {
      const key = prefix ? `${prefix}.${name}` : name;
      const sub = fs['allOf'] ? mergeAllOf(fs) : fs;
      if (sub['properties']) {
        walk(sub['properties'] as Record<string, Record<string, unknown>>, key);
      } else {
        values[key] = defaultFieldValue(fs);
      }
    }
  }

  const props = resolved['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (props) walk(props, '');

  return values;
}

// ── DateTime helpers ──────────────────────────────────────────────────────
type DtSeg = 'year' | 'month' | 'day' | 'hour' | 'min' | 'sec';
const DT_SEGS: DtSeg[] = ['year', 'month', 'day', 'hour', 'min', 'sec'];
const DATE_SEGS: DtSeg[] = ['year', 'month', 'day'];

function parseDt(value: string): Record<DtSeg, number> {
  const now = new Date();
  const def = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), min: now.getMinutes(), sec: now.getSeconds() };
  if (!value) return def;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return def;
  return { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +(m[4] ?? '0'), min: +(m[5] ?? '0'), sec: +(m[6] ?? '0') };
}

function formatDt(d: Record<DtSeg, number>, dateOnly: boolean): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return dateOnly
    ? `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}`
    : `${p(d.year, 4)}-${p(d.month)}-${p(d.day)}T${p(d.hour)}:${p(d.min)}:${p(d.sec)}`;
}

function clampDt(seg: DtSeg, val: number, d: Record<DtSeg, number>): number {
  const mins: Record<DtSeg, number> = { year: 1900, month: 1, day: 1, hour: 0, min: 0, sec: 0 };
  const daysInMonth = new Date(d.year, d.month, 0).getDate();
  const maxs: Record<DtSeg, number> = { year: 2100, month: 12, day: daysInMonth, hour: 23, min: 59, sec: 59 };
  return Math.max(mins[seg], Math.min(maxs[seg], val));
}

// ── Specialized display components ────────────────────────────────────────
function BooleanDisplay({ value, nullable }: { value: string; nullable: boolean }) {
  const opts = nullable ? ['true', 'false', 'null'] : ['true', 'false'];
  return (
    <Box>
      {opts.map((opt, i) => (
        <Text key={opt}>
          {i > 0 && <Text color="gray">{' '}</Text>}
          {opt === value
            ? <Text backgroundColor={opt === 'null' ? 'gray' : opt === 'true' ? 'green' : 'red'} color="black">{` ${opt} `}</Text>
            : <Text color="gray">{opt}</Text>}
        </Text>
      ))}
      <Text color="gray">{'  [←→]'}</Text>
    </Box>
  );
}

function EnumDisplay({ value, opts }: { value: string; opts: string[] }) {
  // opts[0] is always '' (empty/unset), displayed as '—'
  return (
    <Box>
      {opts.map((opt, i) => (
        <Text key={i}>
          {i > 0 && <Text color="gray">{' '}</Text>}
          {opt === value
            ? <Text backgroundColor={opt === '' ? 'gray' : 'cyan'} color="black">{` ${opt || '—'} `}</Text>
            : <Text color={opt === '' ? 'gray' : 'gray'}>{opt || '—'}</Text>}
        </Text>
      ))}
      <Text color="gray">{'  [←→]'}</Text>
    </Box>
  );
}

function DateTimeDisplay({ value, segIdx, dateOnly }: { value: string; segIdx: number; dateOnly: boolean }) {
  if (!value) {
    return <Text color="gray">{'—  [↑↓] set to now  [n] now'}</Text>;
  }
  const d = parseDt(value);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const segs = dateOnly ? DATE_SEGS : DT_SEGS;
  const labels = [p(d.year, 4), p(d.month), p(d.day), p(d.hour), p(d.min), p(d.sec)];
  const seps = ['', '-', '-', 'T', ':', ':'];
  return (
    <Box>
      {segs.map((seg, i) => (
        <Text key={seg}>
          <Text color="gray">{seps[i]}</Text>
          <Text color={i === segIdx ? 'black' : 'white'} backgroundColor={i === segIdx ? 'cyan' : undefined}>
            {labels[i]}
          </Text>
        </Text>
      ))}
      <Text color="gray">{'  [←→] seg  [↑↓] val  [n] now  [Del] clear'}</Text>
    </Box>
  );
}

// ── Extract meta from a Parameter schema ─────────────────────────────────
function paramMeta(p: { type: string; schema?: Record<string, unknown> }) {
  const baseType = p.type.replace('?', '');
  const sc = p.schema ?? {};
  const nullable = p.type.includes('?') || Boolean(sc['nullable']);
  const rawEnum = sc['enum'] as unknown[] | undefined;
  const enumValues = rawEnum && rawEnum.length > 0 ? rawEnum.map(String) : undefined;
  const format = sc['format'] as string | undefined;
  return { baseType, nullable, enumValues, format };
}

// ── Persistent cache ──────────────────────────────────────────────────────
export interface CachedForm {
  pathValues: Record<string, string>;
  queryValues: Record<string, string>;
  headersStr: string;
  bodyFieldValues: Record<string, string>;
}
const formCache = new Map<string, CachedForm>();

/** Pre-fill form cache from outside (e.g. history load) */
export function preFillFormCache(endpointId: string, values: Partial<CachedForm>): void {
  const existing = formCache.get(endpointId);
  formCache.set(endpointId, {
    pathValues: values.pathValues ?? existing?.pathValues ?? {},
    queryValues: values.queryValues ?? existing?.queryValues ?? {},
    headersStr: values.headersStr ?? existing?.headersStr ?? '',
    bodyFieldValues: values.bodyFieldValues ?? existing?.bodyFieldValues ?? {},
  });
}

// ── FormRow types ─────────────────────────────────────────────────────────
type FormRow =
  | { kind: 'path'; param: Endpoint['parameters'][0] }
  | { kind: 'query'; param: Endpoint['parameters'][0] }
  | { kind: 'token' }
  | { kind: 'headers' }
  | { kind: 'body-field'; field: BodyFieldDef };

// ─────────────────────────────────────────────────────────────────────────
export function RequestForm({ endpoint, env, fallbackBaseUrl = '', onClose, height }: RequestFormProps) {
  const { state, dispatch } = useApp();
  const liveEnv = useActiveEnvironment();
  const envVarEntries = Object.entries(liveEnv?.variables ?? {});

  const pathParams = endpoint.parameters.filter((p) => p.in === 'path');
  const queryParams = endpoint.parameters.filter((p) => p.in === 'query');

  const bodyFieldDefs = useMemo(
    () => endpoint.requestBody?.schema ? extractBodyFields(endpoint.requestBody.schema) : [],
    [endpoint.requestBody]
  );

  const cached = formCache.get(endpoint.id);

  const [baseUrlInput, setBaseUrlInput] = useState(env?.baseUrl ?? fallbackBaseUrl);
  const [pathValues, setPathValues] = useState<Record<string, string>>(
    cached?.pathValues ?? Object.fromEntries(pathParams.map((p) => [p.name, p.default ?? '']))
  );
  const [queryValues, setQueryValues] = useState<Record<string, string>>(
    cached?.queryValues ?? Object.fromEntries(queryParams.map((p) => [p.name, p.default ?? '']))
  );
  const [headersStr, setHeadersStr] = useState(cached?.headersStr ?? '');
  const [bodyFieldValues, setBodyFieldValues] = useState<Record<string, string>>(
    cached?.bodyFieldValues ?? buildInitialFieldValues(bodyFieldDefs, endpoint.requestBody?.schema)
  );

  useEffect(() => {
    formCache.set(endpoint.id, { pathValues, queryValues, headersStr, bodyFieldValues });
  }, [endpoint.id, pathValues, queryValues, headersStr, bodyFieldValues]);

  const setBodyField = useCallback((key: string, value: string) => {
    setBodyFieldValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const [focusedField, setFocusedField] = useState<string>('baseUrl');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [scrollOff, setScrollOff] = useState(0);
  const [treeMode, setTreeMode] = useState(false);
  const [collapsedBodyGroups, setCollapsedBodyGroups] = useState<Set<string>>(new Set());
  const [dateSegIdx, setDateSegIdx] = useState(0);
  const [dtTypeBuf, setDtTypeBuf] = useState('');
  const [saveMode, setSaveMode] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [varPickerOpen, setVarPickerOpen] = useState(false);
  const [varPickerIdx, setVarPickerIdx] = useState(0);
  const [fakerOpen, setFakerOpen] = useState(false);
  const [fakerIdx, setFakerIdx] = useState(0);
  const [fakerValues, setFakerValues] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [importError, setImportError] = useState('');
  const [histCompValues, setHistCompValues] = useState<string[]>([]);
  const [histCompIdx, setHistCompIdx] = useState(-1);
  const [fieldPatterns, setFieldPatterns] = useState<Record<string, string>>(() => getFieldPatterns());
  const [fakerPatternMode, setFakerPatternMode] = useState(false);
  const [patternFeedback, setPatternFeedback] = useState('');
  const [patternsOpen, setPatternsOpen] = useState(false);
  const [patternsIdx, setPatternsIdx] = useState(0);
  // Field lookup state
  const [fieldLookups, setFieldLookups] = useState<Record<string, FieldLookup>>(() => getFieldLookups());
  const [lookupSetupOpen, setLookupSetupOpen] = useState(false);
  const [lookupSetupStep, setLookupSetupStep] = useState<'source' | 'endpoint' | 'query-params' | 'body' | 'value-path' | 'label-path' | 'save-name'>('endpoint');
  const [lookupSetupFilter, setLookupSetupFilter] = useState('');
  const [lookupSetupEndpointId, setLookupSetupEndpointId] = useState('');
  const [lookupSetupEndpointIdx, setLookupSetupEndpointIdx] = useState(0);
  const [lookupSetupValuePath, setLookupSetupValuePath] = useState('');
  const [lookupSetupLabelPath, setLookupSetupLabelPath] = useState('');
  const [lookupPickerOpen, setLookupPickerOpen] = useState(false);
  const [lookupPickerItems, setLookupPickerItems] = useState<Array<{ value: string; label?: string }>>([]);
  const [lookupPickerIdx, setLookupPickerIdx] = useState(0);
  const [lookupFetching, setLookupFetching] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupSetupQueryParams, setLookupSetupQueryParams] = useState('');
  const [lookupSetupBody, setLookupSetupBody] = useState('');
  const [lookupSetupSaveName, setLookupSetupSaveName] = useState('');
  const [lookupSetupSourceIdx, setLookupSetupSourceIdx] = useState(0);
  const [savedLookups, setSavedLookups] = useState<Record<string, FieldLookup>>(() => getSavedLookups());

  // Navigation fields — group headers navigable as body-group:key, children skipped when group is collapsed
  const fields = useMemo(() => {
    const result: string[] = [
      'baseUrl',
      ...pathParams.map((p) => `path:${p.name}`),
      ...queryParams.map((p) => `query:${p.name}`),
      'headers',
    ];
    for (const f of bodyFieldDefs) {
      if (isChildOfCollapsed(f.fullKey, collapsedBodyGroups)) continue;
      result.push(f.isGroupHeader ? `body-group:${f.fullKey}` : `body:${f.fullKey}`);
    }
    result.push('__submit__');
    return result;
  }, [pathParams, queryParams, bodyFieldDefs, collapsedBodyGroups]);

  const { state: reqState, result, execute } = useRequest();

  const scrollRows: FormRow[] = useMemo(() => [
    ...pathParams.map((p) => ({ kind: 'path' as const, param: p })),
    ...queryParams.map((p) => ({ kind: 'query' as const, param: p })),
    ...(env?.tokenProvider ? [{ kind: 'token' as const }] : []),
    { kind: 'headers' as const },
    ...bodyFieldDefs
      .filter((f) => !isChildOfCollapsed(f.fullKey, collapsedBodyGroups))
      .map((f) => ({ kind: 'body-field' as const, field: f })),
  ], [pathParams, queryParams, env, bodyFieldDefs, collapsedBodyGroups]);

  const responseHeight = result ? Math.min(Math.floor(height / 2), 14) : 0;
  const formHeight = height - responseHeight;
  const maxScrollVisible = Math.max(1, formHeight - 5);

  const focusedRowIdx = useMemo(() => scrollRows.findIndex((row) => {
    if (row.kind === 'path') return focusedField === `path:${row.param.name}`;
    if (row.kind === 'query') return focusedField === `query:${row.param.name}`;
    if (row.kind === 'headers') return focusedField === 'headers';
    if (row.kind === 'body-field') {
      if (row.field.isGroupHeader) return focusedField === `body-group:${row.field.fullKey}`;
      return focusedField === `body:${row.field.fullKey}`;
    }
    return false;
  }), [focusedField, scrollRows]);

  useEffect(() => {
    if (focusedRowIdx < 0) { setScrollOff(0); return; }
    setScrollOff((prev) => {
      if (focusedRowIdx < prev) return focusedRowIdx;
      if (focusedRowIdx >= prev + maxScrollVisible) return focusedRowIdx - maxScrollVisible + 1;
      return prev;
    });
  }, [focusedRowIdx, maxScrollVisible]);

  const visibleRows = scrollRows.slice(scrollOff, scrollOff + maxScrollVisible);
  const hasMoreAbove = scrollOff > 0;
  const hasMoreBelow = scrollOff + maxScrollVisible < scrollRows.length;

  const moveFocus = useCallback((dir: 1 | -1) => {
    setFocusedField((cur) => {
      const idx = fields.indexOf(cur);
      const next = (idx + dir + fields.length) % fields.length;
      return fields[next] ?? cur;
    });
  }, [fields]);

  // Load history completion values when entering edit mode on a path/query param
  useEffect(() => {
    if (!editingField || (!editingField.startsWith('path:') && !editingField.startsWith('query:'))) {
      setHistCompValues([]);
      setHistCompIdx(-1);
      return;
    }
    const isPath = editingField.startsWith('path:');
    const paramName = isPath ? editingField.slice(5) : editingField.slice(6);
    const vals = getPastParamValues(endpoint.id, isPath ? 'pathParams' : 'queryParams', paramName);
    setHistCompValues(vals);
    setHistCompIdx(-1);
  }, [editingField, endpoint.id]);

  const effectiveBaseUrl = env?.baseUrl ?? baseUrlInput.trim();

  const resolvedPath = useMemo(() => {
    let p = endpoint.path;
    for (const [k, v] of Object.entries(pathValues)) {
      if (v) p = p.replace(`{${k}}`, v);
    }
    return p;
  }, [endpoint.path, pathValues]);

  const handleSubmit = useCallback(async (queryOverrides?: Record<string, string>) => {
    setEditingField(null);
    let parsedHeaders: Record<string, string> = {};
    if (headersStr.trim()) {
      try { parsedHeaders = JSON.parse(headersStr); } catch { /* ignore */ }
    }
    const bodyStr = bodyFieldDefs.length > 0
      ? serializeBodyFields(bodyFieldDefs, bodyFieldValues, collapsedBodyGroups)
      : '';
    const values: RequestValues = {
      pathParams: pathValues,
      queryParams: queryOverrides ? { ...queryValues, ...queryOverrides } : queryValues,
      headers: parsedHeaders,
      body: bodyStr,
    };
    await execute(endpoint, values, env, effectiveBaseUrl);
  }, [pathValues, queryValues, headersStr, bodyFieldValues, bodyFieldDefs, collapsedBodyGroups, endpoint, env, effectiveBaseUrl, execute]);

  const handleSave = useCallback(() => {
    const name = saveName.trim() || `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    let parsedHeaders: Record<string, string> = {};
    if (headersStr.trim()) {
      try { parsedHeaders = JSON.parse(headersStr); } catch { /* ignore */ }
    }
    const bodyStr = bodyFieldDefs.length > 0
      ? serializeBodyFields(bodyFieldDefs, bodyFieldValues, collapsedBodyGroups)
      : '';
    saveRequest({
      name,
      endpointId: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      envName: env?.name ?? null,
      values: { pathParams: pathValues, queryParams: queryValues, headers: parsedHeaders, body: bodyStr },
      bodyFieldValues,
    });
    setSaveMode(false);
    setSaveName('');
  }, [saveName, headersStr, bodyFieldDefs, bodyFieldValues, collapsedBodyGroups, pathValues, queryValues, endpoint, env]);

  const handleNextUrl = useCallback((url: string) => {
    try {
      const urlObj = new URL(url);
      const newParams: Record<string, string> = {};
      urlObj.searchParams.forEach((v, k) => { newParams[k] = v; });
      setQueryValues((prev) => ({ ...prev, ...newParams }));
      void handleSubmit(newParams);
    } catch { /* invalid URL */ }
  }, [handleSubmit]);

  const handleNextCursor = useCallback((param: string, value: string) => {
    const override = { [param]: value };
    setQueryValues((prev) => ({ ...prev, ...override }));
    void handleSubmit(override);
  }, [handleSubmit]);

  // Whether this endpoint has any spec-defined examples to offer
  const hasSpecExamples = useMemo(() => {
    if (endpoint.requestBody?.schema?.['example']) return true;
    if (bodyFieldDefs.some((f) => !f.isGroupHeader && f.example !== undefined)) return true;
    if ([...pathParams, ...queryParams].some((p) => p.schema?.['example'] !== undefined)) return true;
    return false;
  }, [endpoint, bodyFieldDefs, pathParams, queryParams]);

  // Spec example for the currently focused field (used in faker picker)
  const currentSpecExample = useMemo((): string | null => {
    const f = focusedField;
    if (f.startsWith('body:')) {
      const def = bodyFieldDefs.find((d) => d.fullKey === f.slice(5) && !d.isGroupHeader);
      if (def?.example !== undefined) return String(def.example);
    }
    if (f.startsWith('path:')) {
      const param = pathParams.find((p) => p.name === f.slice(5));
      const ex = param?.schema?.['example'];
      if (ex !== undefined) return String(ex);
    }
    if (f.startsWith('query:')) {
      const param = queryParams.find((p) => p.name === f.slice(6));
      const ex = param?.schema?.['example'];
      if (ex !== undefined) return String(ex);
    }
    return null;
  }, [focusedField, bodyFieldDefs, pathParams, queryParams]);

  const handleImport = useCallback(() => {
    const parsed = parseCurl(importInput.trim());
    if (!parsed) {
      setImportError('Could not parse cURL — check the command and try again.');
      return;
    }

    // Path params: match URL path against endpoint path template
    const extractedPath = extractPathParams(endpoint.path, parsed.path);
    if (Object.keys(extractedPath).length > 0) {
      setPathValues((prev) => ({ ...prev, ...extractedPath }));
    }

    // Query params: only fill known params
    const knownQuery = new Set(queryParams.map((p) => p.name));
    const filteredQuery = Object.fromEntries(
      Object.entries(parsed.queryParams).filter(([k]) => knownQuery.has(k))
    );
    if (Object.keys(filteredQuery).length > 0) {
      setQueryValues((prev) => ({ ...prev, ...filteredQuery }));
    }

    // Headers: exclude content-type (auto-managed); store the rest as JSON
    const importHeaders = Object.fromEntries(
      Object.entries(parsed.headers)
        .filter(([k]) => k !== 'content-type')
        .map(([k, v]) => [k, v])
    );
    if (Object.keys(importHeaders).length > 0) {
      setHeadersStr(JSON.stringify(importHeaders));
    }

    // Body: map JSON to structured fields when schema exists
    if (parsed.bodyJson && bodyFieldDefs.length > 0) {
      const mapped = deserializeBodyFields(bodyFieldDefs, parsed.bodyJson);
      if (Object.keys(mapped).length > 0) {
        setBodyFieldValues((prev) => ({ ...prev, ...mapped }));
      }
    }

    setImportOpen(false);
    setImportInput('');
    setImportError('');
  }, [importInput, endpoint.path, queryParams, bodyFieldDefs]);

  const insertFakerValue = useCallback((value: string) => {
    const f = focusedField;
    if (f.startsWith('body:')) {
      const fKey = f.slice(5);
      setBodyFieldValues((prev) => ({ ...prev, [fKey]: value }));
    } else if (f.startsWith('path:')) {
      setPathValues((prev) => ({ ...prev, [f.slice(5)]: value }));
    } else if (f.startsWith('query:')) {
      setQueryValues((prev) => ({ ...prev, [f.slice(6)]: value }));
    } else if (f === 'headers') {
      setHeadersStr(value);
    }
  }, [focusedField]);

  // Fill the currently-editing param field (used by history completion Ctrl+↑↓)
  const setEditingFieldValue = useCallback((val: string) => {
    if (!editingField) return;
    if (editingField.startsWith('path:'))  setPathValues((p)  => ({ ...p, [editingField.slice(5)]: val }));
    if (editingField.startsWith('query:')) setQueryValues((p) => ({ ...p, [editingField.slice(6)]: val }));
  }, [editingField]);

  // Compute a smart auto-fill suggestion for an empty field (feature 3)
  const computeFieldSuggestion = useCallback((field: string): string | null => {
    const vars = liveEnv?.variables ?? {};

    /** Check env vars for a matching name — inserts {{varName}} reference */
    const matchVar = (name: string): string | null => {
      if (vars[name]) return `{{${name}}}`;
      const lower = name.toLowerCase();
      for (const k of Object.keys(vars)) {
        if (k.toLowerCase() === lower) return `{{${k}}}`;
      }
      return null;
    };

    if (field.startsWith('body:')) {
      const fKey = field.slice(5);
      if (bodyFieldValues[fKey]) return null;
      const def = bodyFieldDefs.find((d) => d.fullKey === fKey && !d.isGroupHeader);
      if (!def) return null;
      if (def.example !== undefined) return String(def.example);
      const v = matchVar(def.label) ?? matchVar(fKey);
      if (v) return v;
      return suggestFakerForField(def.label, def.type, def.format, def.enumValues, fieldPatterns);
    }
    if (field.startsWith('path:')) {
      const name = field.slice(5);
      if (pathValues[name]) return null;
      const p = pathParams.find((x) => x.name === name);
      if (!p) return null;
      const ex = p.schema?.['example'];
      if (ex !== undefined) return String(ex);
      if (p.default) return p.default;
      const v = matchVar(name);
      if (v) return v;
      return suggestFakerForField(name, p.type, p.schema?.['format'] as string | undefined, undefined, fieldPatterns);
    }
    if (field.startsWith('query:')) {
      const name = field.slice(6);
      if (queryValues[name]) return null;
      const p = queryParams.find((x) => x.name === name);
      if (!p) return null;
      const ex = p.schema?.['example'];
      if (ex !== undefined) return String(ex);
      if (p.default) return p.default;
      const v = matchVar(name);
      if (v) return v;
      return suggestFakerForField(name, p.type, p.schema?.['format'] as string | undefined, undefined, fieldPatterns);
    }
    return null;
  }, [bodyFieldValues, bodyFieldDefs, pathValues, queryValues, pathParams, queryParams, liveEnv, fieldPatterns]);

  const insertVar = useCallback((varName: string) => {
    const placeholder = `{{${varName}}}`;
    if (focusedField.startsWith('body:')) {
      const fKey = focusedField.slice(5);
      setBodyFieldValues((prev) => ({ ...prev, [fKey]: (prev[fKey] ?? '') + placeholder }));
    } else if (focusedField.startsWith('path:')) {
      const pName = focusedField.slice(5);
      setPathValues((prev) => ({ ...prev, [pName]: (prev[pName] ?? '') + placeholder }));
    } else if (focusedField.startsWith('query:')) {
      const pName = focusedField.slice(6);
      setQueryValues((prev) => ({ ...prev, [pName]: (prev[pName] ?? '') + placeholder }));
    } else if (focusedField === 'headers') {
      setHeadersStr((prev) => prev + placeholder);
    }
  }, [focusedField, setBodyFieldValues, setPathValues, setQueryValues]);

  /** Returns the key used for field-lookup storage for the currently focused field */
  const currentFieldLookupKey = useCallback((): string | null => {
    const f = focusedField;
    if (f.startsWith('body:')) {
      const def = bodyFieldDefs.find((d) => d.fullKey === f.slice(5) && !d.isGroupHeader);
      return def?.label ?? null;
    }
    if (f.startsWith('path:')) return f.slice(5);
    if (f.startsWith('query:')) return f.slice(6);
    return null;
  }, [focusedField, bodyFieldDefs]);

  /** Execute the configured lookup endpoint and open the value picker */
  const executeLookup = useCallback((lookup: FieldLookup) => {
    const lookupEndpoint = state.spec?.endpoints.find((e) => e.id === lookup.endpointId);
    if (!lookupEndpoint) return;
    setLookupFetching(true);
    setLookupError('');
    const lookupValues = {
      pathParams: {},
      queryParams: lookup.queryParams ?? {},
      headers: {},
      body: lookup.body ?? '',
    };
    void executeRequest(lookupEndpoint, lookupValues, liveEnv, liveEnv?.baseUrl ?? env?.baseUrl ?? '')
      .then((result) => {
        setLookupFetching(false);
        if (result.error || result.body === null || result.body === undefined) {
          setLookupError(result.error ?? 'Empty response');
          setTimeout(() => setLookupError(''), 3000);
          return;
        }
        const values = resolvePathArray(result.body, lookup.valuePath);
        const labels = lookup.labelPath ? resolvePathArray(result.body, lookup.labelPath) : [];
        const items = values.map((v, i) => ({ value: v, label: labels[i] }));
        if (items.length === 0) {
          setLookupError('No values found at path');
          setTimeout(() => setLookupError(''), 3000);
          return;
        }
        setLookupPickerItems(items);
        setLookupPickerIdx(0);
        setLookupPickerOpen(true);
      });
  }, [state.spec, liveEnv, env]);

  useInput((input, key) => {
    if (treeMode) return;

    if (lookupPickerOpen) {
      if (key.escape) { setLookupPickerOpen(false); return; }
      if (key.upArrow) { setLookupPickerIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setLookupPickerIdx((i) => Math.min(lookupPickerItems.length - 1, i + 1)); return; }
      if (key.return && lookupPickerItems.length > 0) {
        const item = lookupPickerItems[lookupPickerIdx];
        if (item) insertFakerValue(item.value);
        setLookupPickerOpen(false);
        return;
      }
      return;
    }

    if (lookupSetupOpen) {
      const allEndpoints = state.spec?.endpoints ?? [];
      const savedEntries = Object.entries(savedLookups);

      const applyAndClose = (lookup: FieldLookup) => {
        const fieldKey = currentFieldLookupKey();
        if (fieldKey) { setFieldLookup(fieldKey, lookup); setFieldLookups(getFieldLookups()); }
        setLookupSetupOpen(false);
      };

      if (lookupSetupStep === 'source') {
        if (key.escape) { setLookupSetupOpen(false); return; }
        if (key.upArrow) { setLookupSetupSourceIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setLookupSetupSourceIdx((i) => Math.min(Math.max(0, savedEntries.length - 1), i + 1)); return; }
        if (input === 'n') { setLookupSetupStep('endpoint'); setLookupSetupFilter(''); setLookupSetupEndpointIdx(0); return; }
        if (input === 'd' && savedEntries.length > 0) {
          const entry = savedEntries[lookupSetupSourceIdx];
          if (entry) { removeSavedLookup(entry[0]); setSavedLookups(getSavedLookups()); setLookupSetupSourceIdx((i) => Math.max(0, i - 1)); }
          return;
        }
        if (key.return && savedEntries.length > 0) {
          const entry = savedEntries[lookupSetupSourceIdx];
          if (entry) applyAndClose(entry[1]);
          return;
        }
        return;
      }

      if (lookupSetupStep === 'endpoint') {
        const filtered = lookupSetupFilter
          ? allEndpoints.filter((e) => `${e.method} ${e.path}`.toLowerCase().includes(lookupSetupFilter.toLowerCase()))
          : allEndpoints;
        if (key.escape) {
          if (savedEntries.length > 0) { setLookupSetupStep('source'); } else { setLookupSetupOpen(false); }
          return;
        }
        if (key.upArrow) { setLookupSetupEndpointIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setLookupSetupEndpointIdx((i) => Math.min(Math.max(0, filtered.length - 1), i + 1)); return; }
        if (key.return) {
          const ep = filtered[lookupSetupEndpointIdx];
          if (ep) { setLookupSetupEndpointId(ep.id); setLookupSetupQueryParams(''); setLookupSetupStep('query-params'); }
          return;
        }
        return;
      }

      if (lookupSetupStep === 'query-params') {
        if (key.escape) { setLookupSetupStep('endpoint'); return; }
        if (key.return) {
          const ep = allEndpoints.find((e) => e.id === lookupSetupEndpointId);
          setLookupSetupBody('');
          setLookupSetupStep(ep?.requestBody ? 'body' : 'value-path');
          setLookupSetupValuePath('');
          return;
        }
        return;
      }

      if (lookupSetupStep === 'body') {
        if (key.escape) { setLookupSetupStep('query-params'); return; }
        if (key.return) { setLookupSetupValuePath(''); setLookupSetupStep('value-path'); return; }
        return;
      }

      if (lookupSetupStep === 'value-path') {
        if (key.escape) {
          const ep = allEndpoints.find((e) => e.id === lookupSetupEndpointId);
          setLookupSetupStep(ep?.requestBody ? 'body' : 'query-params');
          return;
        }
        if (key.return && lookupSetupValuePath.trim()) { setLookupSetupLabelPath(''); setLookupSetupStep('label-path'); return; }
        return;
      }

      if (lookupSetupStep === 'label-path') {
        if (key.escape) { setLookupSetupStep('value-path'); return; }
        if (key.return) { setLookupSetupSaveName(''); setLookupSetupStep('save-name'); return; }
        return;
      }

      if (lookupSetupStep === 'save-name') {
        if (key.escape) { setLookupSetupStep('label-path'); return; }
        if (key.return) {
          const ep = allEndpoints.find((e) => e.id === lookupSetupEndpointId);
          if (ep) {
            let qp: Record<string, string> | undefined;
            if (lookupSetupQueryParams.trim()) {
              try { qp = JSON.parse(lookupSetupQueryParams) as Record<string, string>; } catch { /* ignore */ }
            }
            const lookup: FieldLookup = {
              endpointId: ep.id, method: ep.method, path: ep.path,
              valuePath: lookupSetupValuePath.trim(),
              labelPath: lookupSetupLabelPath.trim() || undefined,
              queryParams: qp,
              body: lookupSetupBody.trim() || undefined,
            };
            if (lookupSetupSaveName.trim()) {
              saveLookup(lookupSetupSaveName.trim(), lookup);
              setSavedLookups(getSavedLookups());
            }
            applyAndClose(lookup);
          }
          return;
        }
        return;
      }

      return;
    }

    if (patternsOpen) {
      const patternList = Object.entries(fieldPatterns);
      if (key.escape) { setPatternsOpen(false); return; }
      if (key.upArrow) { setPatternsIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setPatternsIdx((i) => Math.min(Math.max(0, patternList.length - 1), i + 1)); return; }
      if (input === 'd' && patternList.length > 0) {
        const entry = patternList[patternsIdx];
        if (entry) {
          removeFieldPattern(entry[0]);
          const next = getFieldPatterns();
          setFieldPatterns(next);
          setPatternsIdx((i) => Math.max(0, Math.min(i, Object.keys(next).length - 1)));
        }
        return;
      }
      return;
    }

    if (varPickerOpen) {
      if (key.escape) { setVarPickerOpen(false); return; }
      if (key.upArrow) { setVarPickerIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setVarPickerIdx((i) => Math.min(envVarEntries.length - 1, i + 1)); return; }
      if (key.return && envVarEntries.length > 0) {
        const entry = envVarEntries[varPickerIdx];
        if (entry) { insertVar(entry[0]); }
        setVarPickerOpen(false);
        return;
      }
      return;
    }

    if (fakerOpen) {
      if (key.escape) { setFakerOpen(false); setFakerPatternMode(false); return; }
      if (key.upArrow) {
        setFakerIdx((i) => {
          if (i <= 0) return (!fakerPatternMode && currentSpecExample !== null) ? -1 : 0;
          return i - 1;
        });
        return;
      }
      if (key.downArrow) {
        setFakerIdx((i) => {
          if (i === -1) return 0;
          return Math.min(FAKER_ENTRIES.length - 1, i + 1);
        });
        return;
      }
      if (input === ' ') {
        // Regenerate value for current type (not applicable to spec example)
        if (fakerIdx >= 0) {
          const entry = FAKER_ENTRIES[fakerIdx];
          if (entry) setFakerValues((prev) => ({ ...prev, [entry.id]: entry.generate() }));
        }
        return;
      }
      if (key.return) {
        if (fakerPatternMode) {
          // Save pattern instead of inserting value
          if (fakerIdx >= 0) {
            const entry = FAKER_ENTRIES[fakerIdx];
            if (entry) {
              const f = focusedField;
              let patternKey = '';
              if (f.startsWith('body:')) {
                const def = bodyFieldDefs.find((d) => d.fullKey === f.slice(5) && !d.isGroupHeader);
                patternKey = def?.label ?? f.slice(5);
              } else if (f.startsWith('path:')) {
                patternKey = f.slice(5);
              } else if (f.startsWith('query:')) {
                patternKey = f.slice(6);
              }
              if (patternKey) {
                setFieldPattern(patternKey, entry.id);
                setFieldPatterns(getFieldPatterns());
                setPatternFeedback(`✓ Pattern saved: ${patternKey} → ${entry.label}`);
                setTimeout(() => setPatternFeedback(''), 2500);
              }
            }
          }
          setFakerOpen(false);
          setFakerPatternMode(false);
          return;
        }
        if (fakerIdx === -1 && currentSpecExample !== null) {
          insertFakerValue(currentSpecExample);
        } else {
          const entry = FAKER_ENTRIES[fakerIdx];
          if (entry) {
            const value = fakerValues[entry.id] ?? entry.generate();
            insertFakerValue(value);
          }
        }
        setFakerOpen(false);
        return;
      }
      return;
    }

    if (importOpen) {
      if (key.escape) { setImportOpen(false); setImportInput(''); setImportError(''); return; }
      if (key.return) { handleImport(); return; }
      return;
    }

    if (saveMode) {
      if (key.return) { handleSave(); return; }
      if (key.escape) { setSaveMode(false); setSaveName(''); return; }
      return;
    }

    if (editingField !== null) {
      if (key.ctrl && key.return) { void handleSubmit(); return; }
      // Ctrl+↑↓: cycle through history values for path/query params (feature 7)
      if (key.ctrl && (key.upArrow || key.downArrow) && histCompValues.length > 0) {
        const newIdx = key.upArrow
          ? (histCompIdx <= 0 ? histCompValues.length - 1 : histCompIdx - 1)
          : (histCompIdx + 1) % histCompValues.length;
        setHistCompIdx(newIdx);
        setEditingFieldValue(histCompValues[newIdx]!);
        return;
      }
      if (key.return) { setEditingField(null); moveFocus(1); return; }
      if (key.escape) { setEditingField(null); return; }

      // Specialized body field handling
      if (editingField.startsWith('body:')) {
        const fKey = editingField.slice(5);
        const fDef = bodyFieldDefs.find((f) => f.fullKey === fKey);
        if (fDef) {
          const baseType = fDef.type.replace('?', '');
          const cur = bodyFieldValues[fKey] ?? '';

          // Boolean toggle
          if (baseType === 'boolean') {
            const opts = fDef.nullable ? ['true', 'false', 'null'] : ['true', 'false'];
            const idx = Math.max(0, opts.indexOf(cur));
            if (key.leftArrow) { setBodyField(fKey, opts[(idx - 1 + opts.length) % opts.length]!); return; }
            if (key.rightArrow || input === ' ') { setBodyField(fKey, opts[(idx + 1) % opts.length]!); return; }
          }

          // Enum cycle
          if (fDef.enumValues && fDef.enumValues.length > 0) {
            const opts = ['', ...(fDef.nullable ? [...fDef.enumValues, 'null'] : fDef.enumValues)];
            const idx = Math.max(0, opts.indexOf(cur));
            if (key.leftArrow) { setBodyField(fKey, opts[(idx - 1 + opts.length) % opts.length]!); return; }
            if (key.rightArrow || input === ' ') { setBodyField(fKey, opts[(idx + 1) % opts.length]!); return; }
          }

          // DateTime segment navigation
          if (fDef.format === 'date-time' || fDef.format === 'date') {
            const dateOnly = fDef.format === 'date';
            const segs = dateOnly ? DATE_SEGS : DT_SEGS;

            if (key.delete || key.backspace) { setBodyField(fKey, ''); setDtTypeBuf(''); return; }
            if (key.leftArrow) { setDateSegIdx((i) => Math.max(0, i - 1)); setDtTypeBuf(''); return; }
            if (key.rightArrow) { setDateSegIdx((i) => Math.min(segs.length - 1, i + 1)); setDtTypeBuf(''); return; }
            if (key.upArrow || key.downArrow) {
              const base = cur || formatDt(parseDt(''), dateOnly);
              if (!cur) { setBodyField(fKey, base); return; }
              const d = parseDt(cur);
              const seg = segs[dateSegIdx]!;
              const next = { ...d, [seg]: clampDt(seg, d[seg] + (key.upArrow ? 1 : -1), d) };
              setBodyField(fKey, formatDt(next, dateOnly)); return;
            }
            if (input === 'n') {
              setBodyField(fKey, formatDt(parseDt(''), dateOnly)); return;
            }
            if (/^\d$/.test(input)) {
              const base = cur || formatDt(parseDt(''), dateOnly);
              const d = parseDt(base);
              const seg = segs[dateSegIdx]!;
              const maxLen = seg === 'year' ? 4 : 2;
              const buf = dtTypeBuf + input;
              const next = { ...d, [seg]: clampDt(seg, parseInt(buf, 10), d) };
              setBodyField(fKey, formatDt(next, dateOnly));
              if (buf.length >= maxLen) { setDateSegIdx((i) => Math.min(segs.length - 1, i + 1)); setDtTypeBuf(''); }
              else { setDtTypeBuf(buf); }
              return;
            }
          }

          // Number: block non-numeric input (text handled by TextInput)
          if (baseType === 'integer') {
            if (!/^[-\d]$/.test(input) && !key.backspace && !key.delete) return;
          }
          if (baseType === 'number') {
            if (!/^[-\d.]$/.test(input) && !key.backspace && !key.delete) return;
          }
        }
      }

      // Specialized path/query param handling
      if (editingField.startsWith('path:') || editingField.startsWith('query:')) {
        const isPath = editingField.startsWith('path:');
        const pName = isPath ? editingField.slice(5) : editingField.slice(6);
        const params = isPath ? pathParams : queryParams;
        const setValues = isPath ? setPathValues : setQueryValues;
        const values = isPath ? pathValues : queryValues;
        const p = params.find((pp) => pp.name === pName);
        if (p) {
          const { baseType, nullable, enumValues, format } = paramMeta(p);
          const cur = values[pName] ?? '';

          if (baseType === 'boolean') {
            const opts = nullable ? ['true', 'false', 'null'] : ['true', 'false'];
            const idx = Math.max(0, opts.indexOf(cur));
            if (key.leftArrow) { setValues((prev) => ({ ...prev, [pName]: opts[(idx - 1 + opts.length) % opts.length]! })); return; }
            if (key.rightArrow || input === ' ') { setValues((prev) => ({ ...prev, [pName]: opts[(idx + 1) % opts.length]! })); return; }
          }

          if (enumValues && enumValues.length > 0) {
            const opts = ['', ...(nullable ? [...enumValues, 'null'] : enumValues)];
            const idx = Math.max(0, opts.indexOf(cur));
            if (key.leftArrow) { setValues((prev) => ({ ...prev, [pName]: opts[(idx - 1 + opts.length) % opts.length]! })); return; }
            if (key.rightArrow || input === ' ') { setValues((prev) => ({ ...prev, [pName]: opts[(idx + 1) % opts.length]! })); return; }
          }

          if (format === 'date-time' || format === 'date') {
            const dateOnly = format === 'date';
            const segs = dateOnly ? DATE_SEGS : DT_SEGS;

            if (key.delete || key.backspace) { setValues((prev) => ({ ...prev, [pName]: '' })); setDtTypeBuf(''); return; }
            if (key.leftArrow) { setDateSegIdx((i) => Math.max(0, i - 1)); setDtTypeBuf(''); return; }
            if (key.rightArrow) { setDateSegIdx((i) => Math.min(segs.length - 1, i + 1)); setDtTypeBuf(''); return; }
            if (key.upArrow || key.downArrow) {
              const base = cur || formatDt(parseDt(''), dateOnly);
              if (!cur) { setValues((prev) => ({ ...prev, [pName]: base })); return; }
              const d = parseDt(cur);
              const seg = segs[dateSegIdx]!;
              const next = { ...d, [seg]: clampDt(seg, d[seg] + (key.upArrow ? 1 : -1), d) };
              setValues((prev) => ({ ...prev, [pName]: formatDt(next, dateOnly) })); return;
            }
            if (input === 'n') { setValues((prev) => ({ ...prev, [pName]: formatDt(parseDt(''), dateOnly) })); return; }
            if (/^\d$/.test(input)) {
              const base = cur || formatDt(parseDt(''), dateOnly);
              const d = parseDt(base);
              const seg = segs[dateSegIdx]!;
              const maxLen = seg === 'year' ? 4 : 2;
              const buf = dtTypeBuf + input;
              const next = { ...d, [seg]: clampDt(seg, parseInt(buf, 10), d) };
              setValues((prev) => ({ ...prev, [pName]: formatDt(next, dateOnly) }));
              if (buf.length >= maxLen) { setDateSegIdx((i) => Math.min(segs.length - 1, i + 1)); setDtTypeBuf(''); }
              else { setDtTypeBuf(buf); }
              return;
            }
          }

          if (baseType === 'integer') {
            if (!/^[-\d]$/.test(input) && !key.backspace && !key.delete) return;
          }
          if (baseType === 'number') {
            if (!/^[-\d.]$/.test(input) && !key.backspace && !key.delete) return;
          }
        }
      }
      return;
    }

    if (key.escape) { onClose(); return; }
    if (input === 'e' && hasSpecExamples) {
      // Fill all fields that have spec-defined examples
      const bodyUpdates: Record<string, string> = {};
      // Try top-level request body example first
      const bodyEx = endpoint.requestBody?.schema?.['example'];
      if (bodyEx && typeof bodyEx === 'object' && !Array.isArray(bodyEx) && bodyFieldDefs.length > 0) {
        const mapped = deserializeBodyFields(bodyFieldDefs, bodyEx as Record<string, unknown>);
        Object.assign(bodyUpdates, mapped);
      }
      // Individual field examples
      for (const f of bodyFieldDefs) {
        if (!f.isGroupHeader && f.example !== undefined && !(f.fullKey in bodyUpdates)) {
          bodyUpdates[f.fullKey] = String(f.example);
        }
      }
      if (Object.keys(bodyUpdates).length > 0) setBodyFieldValues((prev) => ({ ...prev, ...bodyUpdates }));
      // Path + query params
      for (const p of pathParams) {
        const ex = p.schema?.['example'];
        if (ex !== undefined) setPathValues((prev) => ({ ...prev, [p.name]: String(ex) }));
      }
      for (const p of queryParams) {
        const ex = p.schema?.['example'];
        if (ex !== undefined) setQueryValues((prev) => ({ ...prev, [p.name]: String(ex) }));
      }
      return;
    }
    if (input === 'i') {
      setImportOpen(true);
      setImportInput('');
      setImportError('');
      return;
    }
    if (input === 'f') {
      const field = focusedField;
      if (field.startsWith('body:') || field.startsWith('path:') || field.startsWith('query:') || field === 'headers') {
        // Pre-generate all values
        const generated: Record<string, string> = {};
        for (const entry of FAKER_ENTRIES) generated[entry.id] = entry.generate();
        setFakerValues(generated);
        setFakerIdx(currentSpecExample !== null ? -1 : 0);
        setFakerOpen(true);
        return;
      }
    }
    if (input === 'p') {
      const field = focusedField;
      if (field.startsWith('body:') || field.startsWith('path:') || field.startsWith('query:')) {
        const generated: Record<string, string> = {};
        for (const entry of FAKER_ENTRIES) generated[entry.id] = entry.generate();
        setFakerValues(generated);
        setFakerIdx(0);
        setFakerPatternMode(true);
        setFakerOpen(true);
        return;
      }
    }
    if (input === 'P') {
      setPatternsIdx(0);
      setPatternsOpen(true);
      return;
    }
    if (input === 'l') {
      const fieldKey = currentFieldLookupKey();
      if (!fieldKey) return;
      const lookup = fieldLookups[fieldKey];
      if (!lookup) return; // no lookup configured, [L] to configure
      executeLookup(lookup);
      return;
    }
    if (input === 'L') {
      const fieldKey = currentFieldLookupKey();
      if (!fieldKey) return;
      const hasSaved = Object.keys(getSavedLookups()).length > 0;
      setLookupSetupStep(hasSaved ? 'source' : 'endpoint');
      setLookupSetupSourceIdx(0);
      setLookupSetupFilter('');
      setLookupSetupEndpointIdx(0);
      setLookupSetupEndpointId('');
      setLookupSetupQueryParams('');
      setLookupSetupBody('');
      setLookupSetupValuePath('');
      setLookupSetupLabelPath('');
      setLookupSetupSaveName('');
      setSavedLookups(getSavedLookups());
      setLookupSetupOpen(true);
      return;
    }
    if (input === 'v' && envVarEntries.length > 0) {
      const f = focusedField;
      if (f.startsWith('body:') || f.startsWith('path:') || f.startsWith('query:') || f === 'headers') {
        let curVal = '';
        if (f.startsWith('body:')) curVal = bodyFieldValues[f.slice(5)] ?? '';
        else if (f.startsWith('path:')) curVal = pathValues[f.slice(5)] ?? '';
        else if (f.startsWith('query:')) curVal = queryValues[f.slice(6)] ?? '';
        else curVal = headersStr;

        if (/\{\{/.test(curVal)) {
          // Clear back to empty
          if (f.startsWith('body:')) setBodyFieldValues((prev) => ({ ...prev, [f.slice(5)]: '' }));
          else if (f.startsWith('path:')) setPathValues((prev) => ({ ...prev, [f.slice(5)]: '' }));
          else if (f.startsWith('query:')) setQueryValues((prev) => ({ ...prev, [f.slice(6)]: '' }));
          else setHeadersStr('');
          return;
        }

        setVarPickerIdx(0);
        setVarPickerOpen(true);
        return;
      }
    }
    if (input === 'h') { dispatch({ type: 'OPEN_MODAL', modal: 'history' }); return; }
    if (input === 's') { setSaveMode(true); setSaveName(`${endpoint.method.toUpperCase()} ${endpoint.path}`); return; }
    if (input === 'S') { dispatch({ type: 'OPEN_MODAL', modal: 'saved-requests' }); return; }
    if (key.tab && !key.shift) {
      // Feature 3: smart fill — auto-fill empty fields before advancing focus
      const suggestion = computeFieldSuggestion(focusedField);
      if (suggestion !== null) insertFakerValue(suggestion);
      moveFocus(1);
      return;
    }
    if ((key.tab && key.shift) || key.upArrow) { moveFocus(-1); return; }
    if (key.downArrow) { moveFocus(1); return; }
    if (key.return) {
      if (key.ctrl || focusedField === '__submit__') { void handleSubmit(); return; }
      if (focusedField === 'baseUrl' && env) { moveFocus(1); return; }
      if (focusedField.startsWith('body-group:')) {
        const groupKey = focusedField.slice('body-group:'.length);
        setCollapsedBodyGroups((prev) => {
          const next = new Set(prev);
          if (next.has(groupKey)) next.delete(groupKey);
          else next.add(groupKey);
          return next;
        });
        return;
      }
      if (focusedField !== '__submit__') {
        // Auto-initialize specialized fields when entering edit mode
        if (focusedField.startsWith('body:')) {
          const fKey = focusedField.slice(5);
          const fDef = bodyFieldDefs.find((f) => f.fullKey === fKey);
          if (fDef) {
            const cur = bodyFieldValues[fKey] ?? '';
            const baseType = fDef.type.replace('?', '');
            if (baseType === 'boolean' && cur === '') setBodyField(fKey, 'true');
            if (fDef.format === 'date-time' || fDef.format === 'date') {
              setDateSegIdx(0); setDtTypeBuf('');
            }
          }
        }
        if (focusedField.startsWith('path:') || focusedField.startsWith('query:')) {
          const isPath = focusedField.startsWith('path:');
          const pName = isPath ? focusedField.slice(5) : focusedField.slice(6);
          const params = isPath ? pathParams : queryParams;
          const setValues = isPath ? setPathValues : setQueryValues;
          const values = isPath ? pathValues : queryValues;
          const p = params.find((pp) => pp.name === pName);
          if (p) {
            const { baseType, enumValues, format } = paramMeta(p);
            const cur = values[pName] ?? '';
            if (baseType === 'boolean' && cur === '') setValues((prev) => ({ ...prev, [pName]: 'true' }));
            if (format === 'date-time' || format === 'date') { setDateSegIdx(0); setDtTypeBuf(''); }
          }
        }
        setEditingField(focusedField);
      }
      return;
    }
  });

  const isEditing = (id: string) => editingField === id;
  const isFocused = (id: string) => focusedField === id;

  function fieldDisplay(value: string, placeholder: string) {
    if (!value) return <Text color="gray" dimColor>{placeholder}</Text>;
    const display = value.length > 60 ? value.slice(0, 60) + '…' : value;
    const vars = liveEnv?.variables;
    if (/\{\{/.test(value) && vars) {
      const resolved = value.replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? `{{${n}}}`);
      const resolvedDisplay = resolved !== value
        ? (resolved.length > 50 ? resolved.slice(0, 50) + '…' : resolved)
        : null;
      return (
        <Box>
          <Text color="cyan">{display}</Text>
          {resolvedDisplay && <Text color="gray">{`  → ${resolvedDisplay}`}</Text>}
        </Box>
      );
    }
    return <Text color="white">{display}</Text>;
  }

  const form = (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={formHeight} paddingX={1}>

        <Box>
          <Text bold color="cyan">{'REQUEST  '}</Text>
          {saveMode
            ? <Text color="yellow">{'Save as: '}</Text>
            : editingField
            ? <Text wrap="truncate" color="gray">{
                histCompValues.length > 0
                  ? `[^↵] send  [^↑↓] history: ${histCompValues.slice(0, 5).join('  ·  ')}  [↵] confirm  [Esc] cancel`
                  : '[Enter] confirm  [Esc] cancel  [Ctrl+Enter] send'
              }</Text>
            : lookupFetching
            ? <Text color="cyan">{'Fetching lookup options...'}</Text>
            : lookupError
            ? <Text color="red">{`✗ ${lookupError}`}</Text>
            : patternFeedback
            ? <Text color="green">{patternFeedback}</Text>
            : <Text wrap="truncate" color="gray">{(() => {
                const fieldKey = currentFieldLookupKey();
                const hasLookup = fieldKey ? Boolean(fieldLookups[fieldKey]) : false;
                const lookupHint = fieldKey ? (hasLookup ? '  [l] fetch  [L] relink' : '  [L] link lookup') : '';
                return `[↑↓] nav  [↵] edit  [^↵] send  [i] cURL  [s] save  [h] hist  [f] fake  [p] pattern  [P] patterns${lookupHint}${hasSpecExamples ? '  [e] examples' : ''}${envVarEntries.length > 0 ? '  [v] vars' : ''}  [Esc]`;
              })()}</Text>
          }
          {saveMode && (
            <TextInput value={saveName} onChange={setSaveName} focus placeholder={`${endpoint.method.toUpperCase()} ${endpoint.path}`} />
          )}
          {saveMode && <Text color="gray">{'  [Enter] confirm  [Esc] cancel'}</Text>}
        </Box>

        {/* Base URL */}
        <Box>
          <Text color={isFocused('baseUrl') ? 'cyan' : env ? 'green' : 'yellow'}>
            {isFocused('baseUrl') ? '▶ ' : '  '}{'Base URL: '}
          </Text>
          {env ? (
            <Text color="green">{env.baseUrl}<Text color="gray">{`  (${env.name})`}</Text></Text>
          ) : isEditing('baseUrl') ? (
            <TextInput value={baseUrlInput} onChange={setBaseUrlInput} focus placeholder="https://api.example.com" />
          ) : (
            fieldDisplay(baseUrlInput, 'https://api.example.com')
          )}
        </Box>

        {/* URL preview */}
        <Box>
          <Text color="gray">{'  URL:     '}</Text>
          <Text color={effectiveBaseUrl ? 'white' : 'red'} wrap="truncate">
            {effectiveBaseUrl ? effectiveBaseUrl + resolvedPath : '⚠ type a Base URL above'}
          </Text>
        </Box>

        {hasMoreAbove && <Box><Text color="gray">{'  ↑ more...'}</Text></Box>}

        {visibleRows.map((row) => {
          // ── Path param ──
          if (row.kind === 'path') {
            const p = row.param;
            const id = `path:${p.name}`;
            const { baseType, nullable, enumValues, format } = paramMeta(p);
            const placeholder = p.default ? `default: ${p.default}` : p.type;
            const labelColor = isEditing(id) ? 'green' : isFocused(id) ? 'cyan' : p.required ? 'white' : 'gray';
            const val = pathValues[p.name] ?? '';
            const setVal = (v: string) => setPathValues((prev) => ({ ...prev, [p.name]: v }));
            function renderPathInput() {
              if (!isEditing(id)) return fieldDisplay(val, placeholder);
              if (baseType === 'boolean') return <BooleanDisplay value={val} nullable={nullable} />;
              if (enumValues?.length) return <EnumDisplay value={val} opts={['', ...(nullable ? [...enumValues, 'null'] : enumValues)]} />;
              if (format === 'date-time' || format === 'date') return <DateTimeDisplay value={val} segIdx={dateSegIdx} dateOnly={format === 'date'} />;
              if (baseType === 'integer') return <TextInput value={val} onChange={(v) => { if (/^-?\d*$/.test(v)) setVal(v); }} focus placeholder="0" />;
              if (baseType === 'number') return <TextInput value={val} onChange={(v) => { if (/^-?\d*\.?\d*$/.test(v)) setVal(v); }} focus placeholder="0.0" />;
              return <TextInput value={val} onChange={setVal} focus placeholder={placeholder} />;
            }
            return (
              <Box key={id}>
                <Text color={labelColor}>
                  {isFocused(id) ? '▶ ' : '  '}{p.name}{p.required ? <Text color="red">*</Text> : ''}{' (path): '}
                </Text>
                {renderPathInput()}
              </Box>
            );
          }

          // ── Query param ──
          if (row.kind === 'query') {
            const p = row.param;
            const id = `query:${p.name}`;
            const { baseType, nullable, enumValues, format } = paramMeta(p);
            const placeholder = p.default ? `default: ${p.default}` : p.type;
            const labelColor = isEditing(id) ? 'green' : isFocused(id) ? 'cyan' : p.required ? 'white' : 'gray';
            const val = queryValues[p.name] ?? '';
            const setVal = (v: string) => setQueryValues((prev) => ({ ...prev, [p.name]: v }));
            function renderQueryInput() {
              if (!isEditing(id)) return fieldDisplay(val, placeholder);
              if (baseType === 'boolean') return <BooleanDisplay value={val} nullable={nullable} />;
              if (enumValues?.length) return <EnumDisplay value={val} opts={['', ...(nullable ? [...enumValues, 'null'] : enumValues)]} />;
              if (format === 'date-time' || format === 'date') return <DateTimeDisplay value={val} segIdx={dateSegIdx} dateOnly={format === 'date'} />;
              if (baseType === 'integer') return <TextInput value={val} onChange={(v) => { if (/^-?\d*$/.test(v)) setVal(v); }} focus placeholder="0" />;
              if (baseType === 'number') return <TextInput value={val} onChange={(v) => { if (/^-?\d*\.?\d*$/.test(v)) setVal(v); }} focus placeholder="0.0" />;
              return <TextInput value={val} onChange={setVal} focus placeholder={placeholder} />;
            }
            return (
              <Box key={id}>
                <Text color={labelColor}>
                  {isFocused(id) ? '▶ ' : '  '}{p.name}{p.required ? <Text color="red">*</Text> : ''}{' (query): '}
                </Text>
                {renderQueryInput()}
              </Box>
            );
          }

          // ── Token indicator ──
          if (row.kind === 'token') {
            return (
              <Box key="__token__">
                <Text color="gray">{'  '}</Text>
                {hasTokenCached(env!.name)
                  ? <Text color="green">{'⚡ ✓ token cached → ' + (env!.tokenProvider!.headerName || 'Authorization') + ' injected'}</Text>
                  : <Text color="yellow">{'⚡ will fetch token from ' + env!.tokenProvider!.method.toUpperCase() + ' ' + env!.tokenProvider!.path}</Text>
                }
              </Box>
            );
          }

          // ── Headers ──
          if (row.kind === 'headers') {
            const placeholder = env?.tokenProvider ? '{"X-Extra":"value"}' : '{"Authorization":"Bearer ..."}';
            const labelColor = isEditing('headers') ? 'green' : isFocused('headers') ? 'cyan' : 'gray';
            return (
              <Box key="headers">
                <Text color={labelColor}>{isFocused('headers') ? '▶ ' : '  '}{'Headers: '}</Text>
                {isEditing('headers')
                  ? <TextInput value={headersStr} onChange={setHeadersStr} focus placeholder={placeholder} />
                  : fieldDisplay(headersStr, placeholder)}
              </Box>
            );
          }

          // ── Body field ──
          if (row.kind === 'body-field') {
            const f = row.field;
            const indent = '  '.repeat(f.indent + 1); // +1 for the global padding

            // Group header — navigable, toggles collapse on Enter
            if (f.isGroupHeader) {
              const gid = `body-group:${f.fullKey}`;
              const isFoc = isFocused(gid);
              const isCollapsed = collapsedBodyGroups.has(f.fullKey);
              const toggle = isCollapsed ? '▶' : '▼';
              const cursor = isFoc ? '▶ ' : '  ';
              return (
                <Box key={f.fullKey}>
                  <Text color={isFoc ? 'cyan' : 'white'}>
                    {cursor}{indent}{toggle}{' '}<Text bold>{f.label}</Text>
                  </Text>
                  <Text color="gray">{' (' + f.type + ')'}</Text>
                  {f.description && <Text color="gray">{' — ' + f.description.slice(0, 40)}</Text>}
                </Box>
              );
            }

            const id = `body:${f.fullKey}`;

            // Input field
            const labelColor = isEditing(id) ? 'green' : isFocused(id) ? 'cyan' : f.required ? 'white' : 'gray';
            const arrow = isFocused(id) ? '▶ ' : '  ';
            const value = bodyFieldValues[f.fullKey] ?? '';
            const baseType = f.type.replace('?', '');

            // Determine which specialized input to use when editing
            const isBoolean = baseType === 'boolean';
            const isEnum = (f.enumValues?.length ?? 0) > 0;
            const isDateTime = f.format === 'date-time' || f.format === 'date';
            const isInteger = baseType === 'integer';
            const isNumber = baseType === 'number';

            function renderInput() {
              if (!isEditing(id)) return fieldDisplay(value, f.type);
              if (isBoolean) return <BooleanDisplay value={value} nullable={f.nullable} />;
              if (isEnum) {
                const opts = ['', ...(f.nullable ? [...f.enumValues!, 'null'] : f.enumValues!)];
                return <EnumDisplay value={value} opts={opts} />;
              }
              if (isDateTime) return <DateTimeDisplay value={value} segIdx={dateSegIdx} dateOnly={f.format === 'date'} />;
              if (isInteger) {
                return <TextInput value={value} onChange={(v) => { if (/^-?\d*$/.test(v)) setBodyField(f.fullKey, v); }} focus placeholder="0" />;
              }
              if (isNumber) {
                return <TextInput value={value} onChange={(v) => { if (/^-?\d*\.?\d*$/.test(v)) setBodyField(f.fullKey, v); }} focus placeholder="0.0" />;
              }
              return <TextInput value={value} onChange={(v) => setBodyField(f.fullKey, v)} focus placeholder={f.type} />;
            }

            return (
              <Box key={f.fullKey}>
                <Text color={labelColor}>
                  {f.indent > 0 ? <Text color="gray">{indent}{'↳ '}</Text> : arrow}
                  {f.label}{f.required ? <Text color="red">*</Text> : ''}{' '}
                </Text>
                <Text color="gray">{'('}</Text>
                <Text color={labelColor === 'gray' ? 'gray' : 'cyan'}>{f.type}</Text>
                <Text color="gray">{'): '}</Text>
                {renderInput()}
              </Box>
            );
          }

          return null;
        })}

        {hasMoreBelow && <Box><Text color="gray">{'  ↓ more...'}</Text></Box>}

        <Box marginTop={1}>
          {reqState === 'loading' ? (
            <Text><Text color="cyan"><Spinner type="dots" /></Text>{' Sending...'}</Text>
          ) : isFocused('__submit__') ? (
            <Text backgroundColor="green" color="black" bold>{' ↵  SEND REQUEST  '}</Text>
          ) : (
            <Text color="gray">{'  '}<Text color="green">{'[Send]'}</Text>{' Tab to reach · or Ctrl+Enter from anywhere'}</Text>
          )}
        </Box>

      </Box>

      {result && (
        <ResponseView
          result={result}
          height={responseHeight}
          onFullView={() => setTreeMode(true)}
          onRepeat={() => { void handleSubmit(); }}
          onNextUrl={handleNextUrl}
          onNextCursor={handleNextCursor}
        />
      )}
    </Box>
  );

  if (importOpen) {
    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Box>
          <Text bold color="cyan">{'IMPORT FROM cURL  '}</Text>
          <Text color="gray">{'[Enter] parse & fill  [Esc] cancel'}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">{'Paste your cURL command (single or multi-line):'}</Text>
          <Box borderStyle="single" paddingX={1} marginTop={1}>
            <TextInput
              value={importInput}
              onChange={(v) => { setImportInput(v); setImportError(''); }}
              focus
              placeholder={"curl -X POST 'https://…' -H 'Authorization: Bearer …' -d '{…}'"}
            />
          </Box>
          {importError
            ? <Text color="red">{`  ✗ ${importError}`}</Text>
            : <Text color="gray">{'  Fills: path params, query params, headers, body fields'}</Text>
          }
        </Box>
      </Box>
    );
  }

  if (fakerOpen) {
    const targetLabel = focusedField.startsWith('body:') ? focusedField.slice(5)
      : focusedField.startsWith('path:') ? `{${focusedField.slice(5)}}`
      : focusedField.startsWith('query:') ? focusedField.slice(6)
      : 'headers';

    const patternTargetLabel = (() => {
      const f = focusedField;
      if (f.startsWith('body:')) {
        const def = bodyFieldDefs.find((d) => d.fullKey === f.slice(5) && !d.isGroupHeader);
        return def?.label ?? f.slice(5);
      }
      if (f.startsWith('path:')) return f.slice(5);
      if (f.startsWith('query:')) return f.slice(6);
      return '';
    })();

    const categories = Array.from(new Set(FAKER_ENTRIES.map((e) => e.category)));

    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Box>
          {fakerPatternMode ? (
            <>
              <Text bold color="magenta">{'DEFINE PATTERN  '}</Text>
              <Text color="gray">{'for field '}</Text>
              <Text color="white">{patternTargetLabel}</Text>
              <Text color="gray">{'  [↑↓] navigate  [Enter] save  [Esc] cancel'}</Text>
            </>
          ) : (
            <>
              <Text bold color="cyan">{'FAKER  '}</Text>
              <Text color="gray">{'inserting into '}</Text>
              <Text color="white">{targetLabel}</Text>
              <Text color="gray">{'  [↑↓] navigate  [Space] regenerate  [Enter] insert  [Esc] cancel'}</Text>
            </>
          )}
        </Box>
        <Box flexDirection="column">
          {/* Spec example row (only in insert mode, not pattern mode) */}
          {!fakerPatternMode && currentSpecExample !== null && (
            <Box flexDirection="column">
              <Text color="gray">{'  Spec'}</Text>
              <Box>
                <Text backgroundColor={fakerIdx === -1 ? 'cyan' : undefined}>
                  <Text color={fakerIdx === -1 ? 'black' : 'gray'}>{fakerIdx === -1 ? '  ▶ ' : '    '}</Text>
                  <Text color={fakerIdx === -1 ? 'black' : 'white'}>{'Spec example'.padEnd(22)}</Text>
                  <Text color={fakerIdx === -1 ? 'black' : 'green'}>{`  ${currentSpecExample.length > 38 ? currentSpecExample.slice(0, 38) + '…' : currentSpecExample}`}</Text>
                </Text>
              </Box>
            </Box>
          )}
          {categories.map((cat) => (
            <Box key={cat} flexDirection="column">
              <Text color="gray">{`  ${cat}`}</Text>
              {FAKER_ENTRIES.filter((e) => e.category === cat).map((entry) => {
                const idx = FAKER_ENTRIES.indexOf(entry);
                const sel = idx === fakerIdx;
                const value = fakerValues[entry.id] ?? '';
                const displayVal = value.length > 38 ? value.slice(0, 38) + '…' : value;
                return (
                  <Box key={entry.id}>
                    <Text backgroundColor={sel ? 'cyan' : undefined}>
                      <Text color={sel ? 'black' : 'gray'}>{sel ? '  ▶ ' : '    '}</Text>
                      <Text color={sel ? 'black' : 'white'}>{entry.label.padEnd(22)}</Text>
                      {!fakerPatternMode && <Text color={sel ? 'black' : 'green'}>{`  ${displayVal}`}</Text>}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  if (varPickerOpen) {
    const targetLabel = focusedField.startsWith('body:') ? focusedField.slice(5)
      : focusedField.startsWith('path:') ? `{${focusedField.slice(5)}}`
      : focusedField.startsWith('query:') ? focusedField.slice(6)
      : 'headers';
    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Box>
          <Text bold color="cyan">{'VARIABLES  '}</Text>
          <Text color="gray">{'inserting into '}</Text>
          <Text color="white">{targetLabel}</Text>
          <Text color="gray">{'  [↑↓] navigate  [Enter] insert  [Esc] cancel'}</Text>
        </Box>
        <Box flexDirection="column">
          {envVarEntries.map(([name, value], i) => {
            const sel = i === varPickerIdx;
            const displayVal = value.length > 60 ? value.slice(0, 60) + '…' : value;
            return (
              <Box key={name}>
                <Text backgroundColor={sel ? 'cyan' : undefined}>
                  <Text color={sel ? 'black' : 'gray'}>{sel ? '  ▶ ' : '    '}</Text>
                  <Text color={sel ? 'black' : 'cyan'}>{`{{${name}}}`}</Text>
                  <Text color={sel ? 'black' : 'gray'}>{`  =  `}</Text>
                  <Text color={sel ? 'black' : 'white'}>{displayVal}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (patternsOpen) {
    const patternList = Object.entries(fieldPatterns);
    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Box>
          <Text bold color="magenta">{'FIELD PATTERNS  '}</Text>
          <Text color="gray">{'[↑↓] navigate  [d] delete  [Esc] close'}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {patternList.length === 0 ? (
            <Text color="gray">{'No patterns defined yet. Press [p] on any body/path/query field to define one.'}</Text>
          ) : (
            patternList.map(([fieldName, fakerId], i) => {
              const fakerEntry = FAKER_ENTRIES.find((e) => e.id === fakerId);
              const sel = i === patternsIdx;
              return (
                <Box key={fieldName}>
                  <Text backgroundColor={sel ? 'cyan' : undefined}>
                    <Text color={sel ? 'black' : 'gray'}>{sel ? '  ▶ ' : '    '}</Text>
                    <Text color={sel ? 'black' : 'white'}>{fieldName.padEnd(24)}</Text>
                    <Text color={sel ? 'black' : 'gray'}>{'  →  '}</Text>
                    <Text color={sel ? 'black' : 'green'}>{fakerEntry?.label ?? fakerId}</Text>
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
        {patternFeedback && (
          <Box marginTop={1}>
            <Text color="green">{patternFeedback}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color="gray">{'Patterns auto-fill empty fields when you press [Tab]'}</Text>
        </Box>
      </Box>
    );
  }

  if (lookupPickerOpen) {
    const fieldKey = currentFieldLookupKey() ?? '';
    const lookup = fieldLookups[fieldKey];
    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Box>
          <Text bold color="cyan">{'LOOKUP  '}</Text>
          <Text color="white">{fieldKey}</Text>
          {lookup && <Text color="gray">{`  from ${lookup.method.toUpperCase()} ${lookup.path}`}</Text>}
          <Text color="gray">{'  [↑↓] navigate  [Enter] select  [Esc] cancel'}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {lookupPickerItems.length === 0 ? (
            <Text color="gray">{'No items'}</Text>
          ) : (
            lookupPickerItems.map((item, i) => {
              const sel = i === lookupPickerIdx;
              return (
                <Box key={i}>
                  <Text backgroundColor={sel ? 'cyan' : undefined}>
                    <Text color={sel ? 'black' : 'gray'}>{sel ? '  ▶ ' : '    '}</Text>
                    <Text color={sel ? 'black' : 'white'}>{item.value}</Text>
                    {item.label && <Text color={sel ? 'black' : 'gray'}>{`  — ${item.label}`}</Text>}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    );
  }

  if (lookupSetupOpen) {
    const allEndpoints = state.spec?.endpoints ?? [];
    const savedEntries = Object.entries(savedLookups);
    const filteredEps = lookupSetupFilter
      ? allEndpoints.filter((e) => `${e.method} ${e.path}`.toLowerCase().includes(lookupSetupFilter.toLowerCase()))
      : allEndpoints;
    const fieldKey = currentFieldLookupKey() ?? '';
    const existingLookup = fieldLookups[fieldKey];
    const selectedEp = allEndpoints.find((e) => e.id === lookupSetupEndpointId);
    const stepLabels: Record<string, string> = {
      source: '1/1 choose preset',
      endpoint: `${savedEntries.length > 0 ? '2' : '1'}/6 endpoint`,
      'query-params': '3/6 query params',
      body: '4/6 body',
      'value-path': '5/6 value path',
      'label-path': '6/6 label path (optional)',
      'save-name': '→ save as preset',
    };

    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        {/* Header */}
        <Box>
          <Text bold color="yellow">{'LINK LOOKUP  '}</Text>
          <Text color="white">{fieldKey}</Text>
          <Text color="gray">{`  [${stepLabels[lookupSetupStep] ?? ''}]`}</Text>
          {existingLookup && lookupSetupStep === 'source' && (
            <Text color="gray">{`  currently: ${existingLookup.method.toUpperCase()} ${existingLookup.path} → ${existingLookup.valuePath}`}</Text>
          )}
        </Box>

        {/* Breadcrumb when past source step */}
        {selectedEp && lookupSetupStep !== 'source' && lookupSetupStep !== 'endpoint' && (
          <Box marginTop={1}>
            <Text color="gray">{'  endpoint: '}<Text color="green">{`${selectedEp.method.toUpperCase()} ${selectedEp.path}`}</Text></Text>
          </Box>
        )}
        {lookupSetupValuePath && (lookupSetupStep === 'label-path' || lookupSetupStep === 'save-name') && (
          <Box>
            <Text color="gray">{'  value: '}<Text color="white">{lookupSetupValuePath}</Text></Text>
          </Box>
        )}
        {lookupSetupLabelPath && lookupSetupStep === 'save-name' && (
          <Box>
            <Text color="gray">{'  label: '}<Text color="white">{lookupSetupLabelPath}</Text></Text>
          </Box>
        )}

        {/* ── source ── */}
        {lookupSetupStep === 'source' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Saved presets — pick one or [n] to configure new:'}</Text>
            <Box flexDirection="column" marginTop={1}>
              {savedEntries.length === 0 ? (
                <Text color="gray">{'  (none yet)'}</Text>
              ) : (
                savedEntries.map(([name, lk], i) => {
                  const sel = i === lookupSetupSourceIdx;
                  return (
                    <Box key={name}>
                      <Text backgroundColor={sel ? 'cyan' : undefined}>
                        <Text color={sel ? 'black' : 'gray'}>{sel ? '  ▶ ' : '    '}</Text>
                        <Text color={sel ? 'black' : 'white'}>{name.padEnd(20)}</Text>
                        <Text color={sel ? 'black' : 'gray'}>{'  '}</Text>
                        <Text color={sel ? 'black' : 'green'}>{`${lk.method.toUpperCase()} ${lk.path}`}</Text>
                        <Text color={sel ? 'black' : 'gray'}>{`  → ${lk.valuePath}`}</Text>
                      </Text>
                    </Box>
                  );
                })
              )}
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[↑↓] nav  [Enter] apply  [n] new  [d] delete  [Esc] cancel'}</Text>
            </Box>
          </Box>
        )}

        {/* ── endpoint ── */}
        {lookupSetupStep === 'endpoint' && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text color="gray">{'Filter: '}</Text>
              <TextInput
                value={lookupSetupFilter}
                onChange={(v) => { setLookupSetupFilter(v); setLookupSetupEndpointIdx(0); }}
                focus
                placeholder="GET /proposta..."
              />
            </Box>
            <Box flexDirection="column" marginTop={1}>
              {filteredEps.slice(0, height - 7).map((ep, i) => {
                const sel = i === lookupSetupEndpointIdx;
                return (
                  <Box key={ep.id}>
                    <Text backgroundColor={sel ? 'cyan' : undefined}>
                      <Text color={sel ? 'black' : 'gray'}>{sel ? '  ▶ ' : '    '}</Text>
                      <Text color={sel ? 'black' : 'green'}>{ep.method.toUpperCase().padEnd(7)}</Text>
                      <Text color={sel ? 'black' : 'white'}>{ep.path}</Text>
                    </Text>
                  </Box>
                );
              })}
              {filteredEps.length === 0 && <Text color="gray">{'  No endpoints match'}</Text>}
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[↑↓] nav  [Enter] select  [Esc] back'}</Text>
            </Box>
          </Box>
        )}

        {/* ── query-params ── */}
        {lookupSetupStep === 'query-params' && (
          <Box flexDirection="column" marginTop={1}>
            {selectedEp && selectedEp.parameters.filter((p) => p.in === 'query').length > 0 && (
              <Text color="gray" dimColor>{
                `  known params: ${selectedEp.parameters.filter((p) => p.in === 'query').map((p) => p.name).join(', ')}`
              }</Text>
            )}
            <Box marginTop={1}>
              <Text color="gray">{'Query params '}<Text dimColor>{'(JSON object, optional — e.g. {"status":"ATIVO"})'}</Text></Text>
            </Box>
            <Box>
              <Text color="cyan">{'  → '}</Text>
              <TextInput
                value={lookupSetupQueryParams}
                onChange={setLookupSetupQueryParams}
                focus
                placeholder='{"status": "ATIVO"}  (leave empty to skip)'
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[Enter] next  [Esc] back'}</Text>
            </Box>
          </Box>
        )}

        {/* ── body ── */}
        {lookupSetupStep === 'body' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Request body '}<Text dimColor>{'(JSON, optional)'}</Text></Text>
            <Box>
              <Text color="cyan">{'  → '}</Text>
              <TextInput
                value={lookupSetupBody}
                onChange={setLookupSetupBody}
                focus
                placeholder='{"tipo": "ATIVO"}  (leave empty to skip)'
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[Enter] next  [Esc] back'}</Text>
            </Box>
          </Box>
        )}

        {/* ── value-path ── */}
        {lookupSetupStep === 'value-path' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Value path '}<Text dimColor>{'(e.g. fields[].id  or  [].uuid  or  data.items[].id)'}</Text></Text>
            <Box>
              <Text color="cyan">{'  → '}</Text>
              <TextInput
                value={lookupSetupValuePath}
                onChange={setLookupSetupValuePath}
                focus
                placeholder="fields[].id"
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[Enter] next  [Esc] back'}</Text>
            </Box>
          </Box>
        )}

        {/* ── label-path ── */}
        {lookupSetupStep === 'label-path' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Display label '}<Text dimColor>{'(optional — shown beside value in picker, e.g. fields[].nome)'}</Text></Text>
            <Box>
              <Text color="cyan">{'  → '}</Text>
              <TextInput
                value={lookupSetupLabelPath}
                onChange={setLookupSetupLabelPath}
                focus
                placeholder="fields[].nome  (leave empty to skip)"
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[Enter] next  [Esc] back'}</Text>
            </Box>
          </Box>
        )}

        {/* ── save-name ── */}
        {lookupSetupStep === 'save-name' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Save as preset '}<Text dimColor>{'(optional — type a name to reuse this config on other fields)'}</Text></Text>
            <Box>
              <Text color="cyan">{'  → '}</Text>
              <TextInput
                value={lookupSetupSaveName}
                onChange={setLookupSetupSaveName}
                focus
                placeholder="Proposta lookup  (leave empty to skip)"
              />
            </Box>
            <Box marginTop={1}>
              <Text color="gray">{'[Enter] save & apply  [Esc] back'}</Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  if (treeMode && result) {
    const statusColor = result.status >= 200 && result.status < 300 ? 'green'
      : result.status >= 400 ? 'red' : 'gray';
    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Box>
          <Text bold color="cyan">{'JSON TREE  '}</Text>
          <Text bold color={statusColor}>{String(result.status)}</Text>
          <Text color="gray">{`  ${result.durationMs}ms  `}</Text>
          <Text color="gray">{'[Esc] back to request'}</Text>
        </Box>
        <JsonTree body={result.body} height={height - 1} isFocused onClose={() => setTreeMode(false)} />
      </Box>
    );
  }

  return form;
}

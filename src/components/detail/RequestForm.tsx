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

    const hasProps = Boolean(effectiveSchema['properties']) || Boolean(effectiveSchema['allOf']);
    const isObject = (effectiveSchema['type'] === 'object' || hasProps) && indent < maxDepth;

    if (isObject && hasProps) {
      // Group header — no input
      fields.push({ label: name, fullKey, type, required: isRequired, description, indent, isGroupHeader: true, nullable, enumValues, format });
      fields.push(...extractBodyFields(effectiveSchema, fullKey, indent + 1, maxDepth));
    } else {
      fields.push({ label: name, fullKey, type, required: isRequired, description, indent, isGroupHeader: false, nullable, enumValues, format });
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
  const { dispatch } = useApp();
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

  const effectiveBaseUrl = env?.baseUrl ?? baseUrlInput.trim();

  const resolvedPath = useMemo(() => {
    let p = endpoint.path;
    for (const [k, v] of Object.entries(pathValues)) {
      if (v) p = p.replace(`{${k}}`, v);
    }
    return p;
  }, [endpoint.path, pathValues]);

  const handleSubmit = useCallback(async () => {
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
      queryParams: queryValues,
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

  useInput((input, key) => {
    if (treeMode) return;

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

    if (saveMode) {
      if (key.return) { handleSave(); return; }
      if (key.escape) { setSaveMode(false); setSaveName(''); return; }
      return;
    }

    if (editingField !== null) {
      if (key.ctrl && key.return) { void handleSubmit(); return; }
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
    if (key.tab && !key.shift) { moveFocus(1); return; }
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
            ? <Text color="gray">{'[Enter] confirm  [Esc] cancel edit  [Ctrl+Enter] send'}</Text>
            : <Box>
                <Text color="gray">{'[↑↓/Tab] navigate  [Enter] edit  [Ctrl+Enter] send  [s] save  [h] history  [Esc] close'}</Text>
                {envVarEntries.length > 0 && <Text color="gray">{'  [v] vars'}</Text>}
              </Box>
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
        <ResponseView result={result} height={responseHeight} onFullView={() => setTreeMode(true)} />
      )}
    </Box>
  );

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

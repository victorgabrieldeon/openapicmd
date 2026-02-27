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

    const effectiveSchema = fs['allOf'] ? mergeAllOf(fs) : fs;
    const hasProps = Boolean(effectiveSchema['properties']) || Boolean(effectiveSchema['allOf']);
    const isObject = (effectiveSchema['type'] === 'object' || hasProps) && indent < maxDepth;

    if (isObject && hasProps) {
      // Group header — no input
      fields.push({ label: name, fullKey, type, required: isRequired, description, indent, isGroupHeader: true });
      fields.push(...extractBodyFields(effectiveSchema, fullKey, indent + 1, maxDepth));
    } else {
      fields.push({ label: name, fullKey, type, required: isRequired, description, indent, isGroupHeader: false });
    }
  }

  return fields;
}

// ── Serialise flat field values → nested JSON object ──────────────────────
function coerceValue(raw: string, type: string): unknown {
  if (raw === '') return undefined;
  if (type === 'number' || type === 'integer') { const n = Number(raw); return isNaN(n) ? raw : n; }
  if (type === 'boolean') return raw === 'true' || raw === '1';
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

// ── Persistent cache ──────────────────────────────────────────────────────
interface CachedForm {
  pathValues: Record<string, string>;
  queryValues: Record<string, string>;
  headersStr: string;
  bodyFieldValues: Record<string, string>;
}
const formCache = new Map<string, CachedForm>();

// ── FormRow types ─────────────────────────────────────────────────────────
type FormRow =
  | { kind: 'path'; param: Endpoint['parameters'][0] }
  | { kind: 'query'; param: Endpoint['parameters'][0] }
  | { kind: 'token' }
  | { kind: 'headers' }
  | { kind: 'body-field'; field: BodyFieldDef };

// ─────────────────────────────────────────────────────────────────────────
export function RequestForm({ endpoint, env, fallbackBaseUrl = '', onClose, height }: RequestFormProps) {
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

  useInput((input, key) => {
    if (treeMode) return;

    if (editingField !== null) {
      if (key.ctrl && key.return) { void handleSubmit(); return; }
      if (key.return) { setEditingField(null); moveFocus(1); return; }
      if (key.escape) { setEditingField(null); return; }
      return;
    }

    if (key.escape) { onClose(); return; }
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
      if (focusedField !== '__submit__') setEditingField(focusedField);
      return;
    }
  });

  const isEditing = (id: string) => editingField === id;
  const isFocused = (id: string) => focusedField === id;

  function fieldDisplay(value: string, placeholder: string) {
    return value
      ? <Text color="white">{value.length > 60 ? value.slice(0, 60) + '…' : value}</Text>
      : <Text color="gray" dimColor>{placeholder}</Text>;
  }

  const form = (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={formHeight} paddingX={1}>

        <Box>
          <Text bold color="cyan">{'REQUEST  '}</Text>
          {editingField
            ? <Text color="gray">{'[Enter] confirm  [Esc] cancel edit  [Ctrl+Enter] send'}</Text>
            : <Text color="gray">{'[↑↓/Tab] navigate  [Enter] edit  [Ctrl+Enter] send  [Esc] close'}</Text>
          }
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
            const placeholder = p.default ? `default: ${p.default}` : p.type;
            const labelColor = isEditing(id) ? 'green' : isFocused(id) ? 'cyan' : p.required ? 'white' : 'gray';
            return (
              <Box key={id}>
                <Text color={labelColor}>
                  {isFocused(id) ? '▶ ' : '  '}{p.name}{p.required ? <Text color="red">*</Text> : ''}{' (path): '}
                </Text>
                {isEditing(id)
                  ? <TextInput value={pathValues[p.name] ?? ''} onChange={(v) => setPathValues((prev) => ({ ...prev, [p.name]: v }))} focus placeholder={placeholder} />
                  : fieldDisplay(pathValues[p.name] ?? '', placeholder)}
              </Box>
            );
          }

          // ── Query param ──
          if (row.kind === 'query') {
            const p = row.param;
            const id = `query:${p.name}`;
            const placeholder = p.default ? `default: ${p.default}` : p.type;
            const labelColor = isEditing(id) ? 'green' : isFocused(id) ? 'cyan' : p.required ? 'white' : 'gray';
            return (
              <Box key={id}>
                <Text color={labelColor}>
                  {isFocused(id) ? '▶ ' : '  '}{p.name}{p.required ? <Text color="red">*</Text> : ''}{' (query): '}
                </Text>
                {isEditing(id)
                  ? <TextInput value={queryValues[p.name] ?? ''} onChange={(v) => setQueryValues((prev) => ({ ...prev, [p.name]: v }))} focus placeholder={placeholder} />
                  : fieldDisplay(queryValues[p.name] ?? '', placeholder)}
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
            const placeholder = f.type;

            return (
              <Box key={f.fullKey}>
                <Text color={labelColor}>
                  {f.indent > 0 ? <Text color="gray">{indent}{'↳ '}</Text> : arrow}
                  {f.label}{f.required ? <Text color="red">*</Text> : ''}{' '}
                </Text>
                <Text color="gray">{'('}</Text>
                <Text color={labelColor === 'gray' ? 'gray' : 'cyan'}>{f.type}</Text>
                <Text color="gray">{'): '}</Text>
                {isEditing(id)
                  ? <TextInput value={value} onChange={(v) => setBodyField(f.fullKey, v)} focus placeholder={placeholder} />
                  : fieldDisplay(value, placeholder)}
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

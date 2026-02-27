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

type FormRow =
  | { kind: 'path'; param: Endpoint['parameters'][0] }
  | { kind: 'query'; param: Endpoint['parameters'][0] }
  | { kind: 'token' }
  | { kind: 'headers' }
  | { kind: 'body' };

/** Build an initial JSON body string from schema defaults.
 *  Only includes fields that have a `default` value defined. */
function buildBodyTemplate(schema: Record<string, unknown> | undefined): string {
  if (!schema) return '';

  // Resolve allOf by merging
  const resolved: Record<string, unknown> = schema['allOf']
    ? (schema['allOf'] as Record<string, unknown>[]).reduce(
        (acc, s) => ({ ...acc, ...(s['properties'] ? { properties: { ...(acc['properties'] as object ?? {}), ...(s['properties'] as object) }, required: [...((acc['required'] as string[]) ?? []), ...((s['required'] as string[]) ?? [])] } : {}) }),
        {} as Record<string, unknown>
      )
    : schema;

  const properties = resolved['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return '';

  const template: Record<string, unknown> = {};
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema['default'] !== undefined) {
      template[name] = fieldSchema['default'];
    }
  }

  return Object.keys(template).length > 0 ? JSON.stringify(template) : '';
}

export function RequestForm({ endpoint, env, fallbackBaseUrl = '', onClose, height }: RequestFormProps) {
  const pathParams = endpoint.parameters.filter((p) => p.in === 'path');
  const queryParams = endpoint.parameters.filter((p) => p.in === 'query');

  const [baseUrlInput, setBaseUrlInput] = useState(env?.baseUrl ?? fallbackBaseUrl);

  const fields = useMemo(() => {
    return [
      'baseUrl',
      ...pathParams.map((p) => `path:${p.name}`),
      ...queryParams.map((p) => `query:${p.name}`),
      'headers',
      ...(endpoint.requestBody ? ['body'] : []),
      '__submit__',
    ];
  }, [pathParams, queryParams, endpoint.requestBody]);

  const [pathValues, setPathValues] = useState<Record<string, string>>(
    Object.fromEntries(pathParams.map((p) => [p.name, p.default ?? '']))
  );
  const [queryValues, setQueryValues] = useState<Record<string, string>>(
    Object.fromEntries(queryParams.map((p) => [p.name, p.default ?? '']))
  );
  const [headersStr, setHeadersStr] = useState('');
  const [bodyStr, setBodyStr] = useState(() => buildBodyTemplate(endpoint.requestBody?.schema));
  const [focusedField, setFocusedField] = useState<string>('baseUrl');
  const [scrollOff, setScrollOff] = useState(0);
  const [treeMode, setTreeMode] = useState(false);

  const { state: reqState, result, execute } = useRequest();

  // Rows in the scrollable middle section (everything between baseUrl/urlPreview and submit)
  const scrollRows: FormRow[] = useMemo(() => [
    ...pathParams.map((p) => ({ kind: 'path' as const, param: p })),
    ...queryParams.map((p) => ({ kind: 'query' as const, param: p })),
    ...(env?.tokenProvider ? [{ kind: 'token' as const }] : []),
    { kind: 'headers' as const },
    ...(endpoint.requestBody ? [{ kind: 'body' as const }] : []),
  ], [pathParams, queryParams, env, endpoint.requestBody]);

  const responseHeight = result ? Math.min(Math.floor(height / 2), 14) : 0;
  const formHeight = height - responseHeight;
  // fixed rows: header(1) + baseUrl(1) + urlPreview(1) + submit(2 with marginTop)
  const maxScrollVisible = Math.max(1, formHeight - 5);

  // Keep the focused row visible by adjusting scrollOff
  const focusedRowIdx = useMemo(() => {
    return scrollRows.findIndex((row) => {
      if (row.kind === 'path') return focusedField === `path:${row.param.name}`;
      if (row.kind === 'query') return focusedField === `query:${row.param.name}`;
      if (row.kind === 'headers') return focusedField === 'headers';
      if (row.kind === 'body') return focusedField === 'body';
      return false;
    });
  }, [focusedField, scrollRows]);

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
    let parsedHeaders: Record<string, string> = {};
    if (headersStr.trim()) {
      try { parsedHeaders = JSON.parse(headersStr); } catch { /* ignore */ }
    }
    const values: RequestValues = {
      pathParams: pathValues,
      queryParams: queryValues,
      headers: parsedHeaders,
      body: bodyStr,
    };
    await execute(endpoint, values, env, effectiveBaseUrl);
  }, [pathValues, queryValues, headersStr, bodyStr, endpoint, env, effectiveBaseUrl, execute]);

  useInput((input, key) => {
    // In tree mode, JsonTree handles its own input — don't interfere
    if (treeMode) return;
    if (key.escape) { onClose(); return; }
    if (key.tab && !key.shift) { moveFocus(1); return; }
    if ((key.tab && key.shift) || key.upArrow) { moveFocus(-1); return; }
    if (key.downArrow) { moveFocus(1); return; }
    if (key.return) {
      if (focusedField === '__submit__' || key.ctrl) { void handleSubmit(); return; }
      moveFocus(1);
      return;
    }
  });

  const f = (id: string) => focusedField === id;

  const form = (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={formHeight} paddingX={1}>

        {/* Header */}
        <Box>
          <Text bold color="cyan">{'REQUEST  '}</Text>
          <Text color="gray">{'[Tab/↑↓] move  [Ctrl+Enter] send  [Esc] cancel'}</Text>
        </Box>

        {/* Base URL — always visible */}
        <Box>
          <Text color={f('baseUrl') ? 'cyan' : env ? 'green' : 'yellow'}>
            {f('baseUrl') ? '▶ ' : '  '}
            {'Base URL: '}
          </Text>
          {env ? (
            <Text color="green">{env.baseUrl}<Text color="gray">{`  (${env.name})`}</Text></Text>
          ) : (
            <TextInput
              value={baseUrlInput}
              onChange={setBaseUrlInput}
              focus={f('baseUrl')}
              placeholder={'https://api.example.com'}
            />
          )}
        </Box>

        {/* Full URL preview — always visible */}
        <Box>
          <Text color="gray">{'  URL:     '}</Text>
          <Text
            color={effectiveBaseUrl ? 'white' : 'red'}
            wrap="truncate"
          >
            {effectiveBaseUrl ? effectiveBaseUrl + resolvedPath : '⚠ type a Base URL above'}
          </Text>
        </Box>

        {/* Scroll indicator above */}
        {hasMoreAbove && (
          <Box>
            <Text color="gray">{'  ↑ more...'}</Text>
          </Box>
        )}

        {/* Scrollable middle section */}
        {visibleRows.map((row, i) => {
          if (row.kind === 'path') {
            const p = row.param;
            const id = `path:${p.name}`;
            const placeholder = p.default ? `default: ${p.default}` : p.type;
            return (
              <Box key={id}>
                <Text color={f(id) ? 'cyan' : p.required ? 'white' : 'gray'}>
                  {f(id) ? '▶ ' : '  '}{p.name}{p.required ? <Text color="red">{'*'}</Text> : ''}{' (path): '}
                </Text>
                <TextInput
                  value={pathValues[p.name] ?? ''}
                  onChange={(v) => setPathValues((prev) => ({ ...prev, [p.name]: v }))}
                  focus={f(id)}
                  placeholder={placeholder}
                />
              </Box>
            );
          }

          if (row.kind === 'query') {
            const p = row.param;
            const id = `query:${p.name}`;
            const placeholder = p.default ? `default: ${p.default}` : p.type;
            return (
              <Box key={id}>
                <Text color={f(id) ? 'cyan' : p.required ? 'white' : 'gray'}>
                  {f(id) ? '▶ ' : '  '}{p.name}{p.required ? <Text color="red">{'*'}</Text> : ''}{' (query): '}
                </Text>
                <TextInput
                  value={queryValues[p.name] ?? ''}
                  onChange={(v) => setQueryValues((prev) => ({ ...prev, [p.name]: v }))}
                  focus={f(id)}
                  placeholder={placeholder}
                />
              </Box>
            );
          }

          if (row.kind === 'token') {
            return (
              <Box key="__token__">
                <Text color="gray">{'  '}</Text>
                {hasTokenCached(env!.name)
                  ? <Text color="green">{'⚡ ✓ token cached → ' + (env!.tokenProvider!.headerName || 'Authorization') + ' will be injected'}</Text>
                  : <Text color="yellow">{'⚡ token provider active → will fetch ' + env!.tokenProvider!.method.toUpperCase() + ' ' + env!.tokenProvider!.path}</Text>
                }
              </Box>
            );
          }

          if (row.kind === 'headers') {
            return (
              <Box key="headers">
                <Text color={f('headers') ? 'cyan' : 'gray'}>
                  {f('headers') ? '▶ ' : '  '}{'Headers: '}
                </Text>
                <TextInput
                  value={headersStr}
                  onChange={setHeadersStr}
                  focus={f('headers')}
                  placeholder={env?.tokenProvider ? '{"X-Extra":"value"} (token auto-injected)' : '{"Authorization":"Bearer ..."}'}
                />
              </Box>
            );
          }

          if (row.kind === 'body') {
            return (
              <Box key="body">
                <Text color={f('body') ? 'cyan' : 'gray'}>
                  {f('body') ? '▶ ' : '  '}{'Body:    '}
                </Text>
                <TextInput
                  value={bodyStr}
                  onChange={setBodyStr}
                  focus={f('body')}
                  placeholder={'{"key":"value"}'}
                />
              </Box>
            );
          }

          return null;
        })}

        {/* Scroll indicator below */}
        {hasMoreBelow && (
          <Box>
            <Text color="gray">{'  ↓ more...'}</Text>
          </Box>
        )}

        {/* Submit */}
        <Box marginTop={1}>
          {reqState === 'loading' ? (
            <Text><Text color="cyan"><Spinner type="dots" /></Text>{' Sending...'}</Text>
          ) : f('__submit__') ? (
            <Text backgroundColor="green" color="black" bold>{' ↵  SEND REQUEST  '}</Text>
          ) : (
            <Text color="gray">
              {'  '}<Text color="green">{'[Send]'}</Text>{' Tab to reach · or Ctrl+Enter from anywhere'}
            </Text>
          )}
        </Box>

      </Box>

      {result && (
        <ResponseView
          result={result}
          height={responseHeight}
          onFullView={() => setTreeMode(true)}
        />
      )}
    </Box>
  );

  // Full-screen JSON tree mode — replaces the entire form
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
        <JsonTree
          body={result.body}
          height={height - 1}
          isFocused={true}
          onClose={() => setTreeMode(false)}
        />
      </Box>
    );
  }

  return form;
}

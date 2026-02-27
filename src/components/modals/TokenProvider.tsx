import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { useApp, useSelectedEndpoint, useActiveEnvironment } from '../../context/AppContext.js';
import { saveEnvironment, getConfig } from '../../lib/config-store.js';
import { testTokenProvider, clearTokenCache, hasTokenCached } from '../../lib/executor.js';
import type { TokenProvider } from '../../types/config.js';

type FormField = 'body' | 'extraHeaders' | 'tokenPath' | 'headerName' | 'prefix';
const FIELDS: FormField[] = ['body', 'extraHeaders', 'tokenPath', 'headerName', 'prefix'];

type TestState = 'idle' | 'loading' | 'ok' | 'error';

interface TestDebug {
  status: number;
  responseBody: unknown;
  networkError?: string;
}

export function TokenProviderModal() {
  const { state, dispatch } = useApp();
  const endpoint = useSelectedEndpoint();
  const activeEnv = useActiveEnvironment();

  // Pre-fill from existing config if already set
  const existing = activeEnv?.tokenProvider;
  const [body, setBody] = useState(existing?.body ?? '{}');
  const [extraHeaders, setExtraHeaders] = useState(
    existing?.extraHeaders && Object.keys(existing.extraHeaders).length
      ? JSON.stringify(existing.extraHeaders)
      : '{}'
  );
  const [tokenPath, setTokenPath] = useState(existing?.tokenPath ?? 'access_token');
  const [headerName, setHeaderName] = useState(existing?.headerName ?? 'Authorization');
  const [prefix, setPrefix] = useState(existing?.prefix ?? 'Bearer ');
  const [focusedField, setFocusedField] = useState<FormField>('body');
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState('');
  const [testDebug, setTestDebug] = useState<TestDebug | null>(null);

  const isCached = activeEnv ? hasTokenCached(activeEnv.name) : false;

  const close = () => dispatch({ type: 'CLOSE_MODAL' });

  const moveFocus = (dir: 1 | -1) => {
    setFocusedField((cur) => {
      const idx = FIELDS.indexOf(cur);
      return FIELDS[(idx + dir + FIELDS.length) % FIELDS.length] ?? 'body';
    });
  };

  const handleSave = useCallback(() => {
    if (!endpoint || !activeEnv) return;
    let parsedHeaders: Record<string, string> = {};
    try { parsedHeaders = JSON.parse(extraHeaders); } catch { parsedHeaders = {}; }

    const provider: TokenProvider = {
      endpointId: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      body,
      extraHeaders: parsedHeaders,
      tokenPath,
      headerName: headerName || 'Authorization',
      prefix: prefix,
    };

    // Clear cache so new config takes effect immediately
    clearTokenCache(activeEnv.name);

    const updatedEnv = { ...activeEnv, tokenProvider: provider };
    saveEnvironment(updatedEnv);

    const config = getConfig();
    dispatch({ type: 'SET_ENVIRONMENTS', environments: config.environments });
    close();
  }, [endpoint, activeEnv, body, extraHeaders, tokenPath, headerName, prefix]);

  const handleRemove = useCallback(() => {
    if (!activeEnv) return;
    clearTokenCache(activeEnv.name);
    const { tokenProvider: _removed, ...rest } = activeEnv;
    saveEnvironment(rest);
    const config = getConfig();
    dispatch({ type: 'SET_ENVIRONMENTS', environments: config.environments });
    close();
  }, [activeEnv]);

  const handleTest = useCallback(async () => {
    if (!endpoint || !activeEnv) return;
    setTestState('loading');
    setTestError('');
    setTestDebug(null);
    let parsedHeaders: Record<string, string> = {};
    try { parsedHeaders = JSON.parse(extraHeaders); } catch { parsedHeaders = {}; }

    clearTokenCache(activeEnv.name);
    const result = await testTokenProvider(
      {
        endpointId: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        body,
        extraHeaders: parsedHeaders,
        tokenPath,
        headerName: headerName || 'Authorization',
        prefix,
      },
      activeEnv.baseUrl,
      activeEnv.name
    );

    setTestDebug({ status: result.status, responseBody: result.responseBody, networkError: result.networkError });

    if (result.token) {
      setTestState('ok');
    } else {
      setTestState('error');
      if (result.networkError) {
        setTestError('Network error: ' + result.networkError);
      } else if (tokenPath.trim()) {
        setTestError('Token not found at path "' + tokenPath + '" in response above');
      } else {
        setTestError('Response body is not a plain string');
      }
    }
  }, [endpoint, activeEnv, body, extraHeaders, tokenPath, headerName, prefix]);

  useInput((input, key) => {
    if (key.escape) { close(); return; }
    if (key.tab && !key.shift) { moveFocus(1); return; }
    if ((key.tab && key.shift) || key.upArrow) { moveFocus(-1); return; }
    if (key.downArrow) { moveFocus(1); return; }
    if (key.return) {
      if (focusedField === 'prefix') { handleSave(); return; }
      moveFocus(1);
      return;
    }
    // Ctrl+R — close modal and go straight to request form
    if (key.ctrl && input === 'r' && endpoint) {
      dispatch({ type: 'CLOSE_MODAL_NAVIGATE', panel: 'request' });
      return;
    }
    // Ctrl+T to test
    if (key.ctrl && input === 't') { void handleTest(); return; }
    // Ctrl+D to remove provider
    if (key.ctrl && input === 'd') { handleRemove(); return; }
    // Ctrl+X to clear cache
    if (key.ctrl && input === 'x') {
      if (activeEnv) clearTokenCache(activeEnv.name);
      return;
    }
  });

  if (!endpoint) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color="red">{'Select an endpoint first'}</Text>
      </Box>
    );
  }
  if (!activeEnv) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color="red">{'Select an environment first [e]'}</Text>
      </Box>
    );
  }

  const field = (f: FormField) => focusedField === f;

  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} width={72}>
        <Text bold color="cyan">{'⚡ Token Provider'}</Text>
        <Box>
          <Text color="gray">{'Endpoint: '}</Text>
          <Text color="green" bold>{endpoint.method.toUpperCase()}</Text>
          <Text color="white">{' ' + endpoint.path}</Text>
          <Text color="gray">{'  →  '}</Text>
          <Text color="yellow">{activeEnv.name}</Text>
          {isCached && <Text color="green">{' ✓ token cached'}</Text>}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {/* ── Step 1 ── */}
          <Text bold color="white">{'Step 1 — Auth request body (JSON):'}</Text>
          <Box>
            <Text color={field('body') ? 'cyan' : 'gray'}>{field('body') ? '▶ ' : '  '}</Text>
            <TextInput value={body} onChange={setBody} focus={field('body')} placeholder={'{"username":"","password":""}'} />
          </Box>

          <Box marginTop={1}>
            <Text color={field('extraHeaders') ? 'cyan' : 'gray'}>{field('extraHeaders') ? '▶ ' : '  '}</Text>
            <Text color="gray">{'Extra headers: '}</Text>
            <TextInput value={extraHeaders} onChange={setExtraHeaders} focus={field('extraHeaders')} placeholder={'{"X-Api-Key":"..."}'} />
          </Box>

          {/* ── Step 2 ── */}
          <Box marginTop={1}>
            <Text bold color="white">{'Step 2 — Extract token from response (dot notation):'}</Text>
          </Box>
          <Box>
            <Text color={field('tokenPath') ? 'cyan' : 'gray'}>{field('tokenPath') ? '▶ ' : '  '}</Text>
            <TextInput value={tokenPath} onChange={setTokenPath} focus={field('tokenPath')} placeholder={'access_token  or  data.token  or leave empty'} />
          </Box>
          {field('tokenPath') && (
            <Box paddingLeft={4}>
              <Text color="gray" dimColor>{'dot notation: access_token | data.token | result.jwt'}</Text>
            </Box>
          )}
          {field('tokenPath') && (
            <Box paddingLeft={4}>
              <Text color="gray" dimColor>{'leave empty if the response body is the token directly (plain string)'}</Text>
            </Box>
          )}

          {/* ── Step 3 ── */}
          <Box marginTop={1}>
            <Text bold color="white">{'Step 3 — Inject into header:'}</Text>
          </Box>
          <Box>
            <Text color={field('headerName') ? 'cyan' : 'gray'}>{field('headerName') ? '▶ ' : '  '}</Text>
            <Text color="gray">{'Header name: '}</Text>
            <TextInput value={headerName} onChange={setHeaderName} focus={field('headerName')} placeholder={'Authorization'} />
          </Box>
          <Box>
            <Text color={field('prefix') ? 'cyan' : 'gray'}>{field('prefix') ? '▶ ' : '  '}</Text>
            <Text color="gray">{'Prefix:      '}</Text>
            <TextInput value={prefix} onChange={setPrefix} focus={field('prefix')} placeholder={'Bearer '} />
          </Box>
          {field('prefix') && (
            <Box paddingLeft={4}>
              <Text color="gray" dimColor>{'Result → ' + (headerName || 'Authorization') + ': ' + prefix + '<token>'}</Text>
            </Box>
          )}
        </Box>

        {/* Test result */}
        {testState !== 'idle' && (
          <Box marginTop={1} flexDirection="column">
            {testState === 'loading' && (
              <Text><Text color="cyan"><Spinner type="dots" /></Text>{' Testing...'}</Text>
            )}
            {testDebug && testState !== 'loading' && (
              <Box flexDirection="column">
                <Box>
                  <Text color="gray">{'Response '}</Text>
                  <Text color={testDebug.status >= 200 && testDebug.status < 300 ? 'green' : 'red'} bold>
                    {String(testDebug.status)}
                  </Text>
                  <Text color="gray">{'  body: '}</Text>
                  <Text color="yellow" wrap="truncate">
                    {testDebug.networkError
                      ? testDebug.networkError
                      : JSON.stringify(testDebug.responseBody).slice(0, 120)}
                  </Text>
                </Box>
                {testState === 'ok' && (
                  <Text color="green">{'✓ Token found and cached'}</Text>
                )}
                {testState === 'error' && (
                  <Text color="red">{'✗ ' + testError}</Text>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Actions */}
        <Box marginTop={1} flexDirection="column">
          <Box>
            {focusedField === 'prefix' ? (
              <Text backgroundColor="green" color="black">{' [Enter] Save '}</Text>
            ) : (
              <Text color="gray">{'  [Enter] next field  •  Tab to Prefix → Enter to save'}</Text>
            )}
          </Box>
          <Box marginTop={0}>
            <Text color="gray">{'  [Ctrl+T] Test  '}</Text>
            <Text color="gray">{'[Ctrl+R] Execute request  '}</Text>
            {existing && <Text color="gray">{'[Ctrl+D] Remove  '}</Text>}
            {isCached && <Text color="gray">{'[Ctrl+X] Clear cache  '}</Text>}
            <Text color="gray">{'[Esc] Cancel'}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp } from '../../context/AppContext.js';
import {
  saveEnvironment,
  deleteEnvironment,
  setActiveEnvironment,
  getConfig,
} from '../../lib/config-store.js';
import type { Environment } from '../../types/config.js';

type View = 'list' | 'add' | 'edit';
type FormField = 'name' | 'specUrl' | 'baseUrl' | 'headers' | 'variables' | 'hook';

const FIELDS: FormField[] = ['name', 'specUrl', 'baseUrl', 'headers', 'variables', 'hook'];

function parseJsonSilent(v: string): Record<string, string> {
  try { return JSON.parse(v); } catch { return {}; }
}

export function EnvManager() {
  const { state, dispatch } = useApp();
  const [view, setView] = useState<View>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [focusedField, setFocusedField] = useState<FormField>('name');

  const [nameVal, setNameVal] = useState('');
  const [specUrlVal, setSpecUrlVal] = useState('');
  const [baseUrlVal, setBaseUrlVal] = useState('');
  const [headersVal, setHeadersVal] = useState('{}');
  const [variablesVal, setVariablesVal] = useState('{}');
  const [hookVal, setHookVal] = useState('');

  const envs = state.environments;

  const openForm = (env?: Environment) => {
    setNameVal(env?.name ?? '');
    setSpecUrlVal(env?.specUrl ?? '');
    setBaseUrlVal(env?.baseUrl ?? '');
    setHeadersVal(env?.headers && Object.keys(env.headers).length ? JSON.stringify(env.headers) : '{}');
    setVariablesVal(env?.variables && Object.keys(env.variables).length ? JSON.stringify(env.variables) : '{}');
    setHookVal(env?.preRequestHook ?? '');
    setFocusedField('name');
  };

  const refreshEnvs = () => {
    const config = getConfig();
    dispatch({ type: 'SET_ENVIRONMENTS', environments: config.environments });
    if (config.activeEnvironment) {
      dispatch({ type: 'SET_ACTIVE_ENV', name: config.activeEnvironment });
    }
  };

  const handleSave = () => {
    const name = nameVal.trim();
    const baseUrl = baseUrlVal.trim();
    if (!name || !baseUrl) return;

    const env: Environment = {
      name,
      baseUrl,
      ...(specUrlVal.trim() ? { specUrl: specUrlVal.trim() } : {}),
      headers: parseJsonSilent(headersVal),
      variables: parseJsonSilent(variablesVal),
      ...(hookVal.trim() ? { preRequestHook: hookVal.trim() } : {}),
    };
    saveEnvironment(env);

    // Auto-activate if no env active yet, or editing the current active env
    const shouldActivate = !state.activeEnvName || state.activeEnvName === name;
    if (shouldActivate) {
      setActiveEnvironment(name);
      dispatch({ type: 'SET_ACTIVE_ENV', name });
    }

    // If this env has a specUrl, load it automatically
    if (env.specUrl && (shouldActivate || state.activeEnvName === name)) {
      dispatch({ type: 'LOAD_SPEC', source: env.specUrl });
    }

    refreshEnvs();
    setView('list');
  };

  const moveFocus = (dir: 1 | -1) => {
    setFocusedField((cur) => {
      const idx = FIELDS.indexOf(cur);
      return FIELDS[(idx + dir + FIELDS.length) % FIELDS.length] ?? 'name';
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      if (view !== 'list') { setView('list'); }
      else { dispatch({ type: 'CLOSE_MODAL' }); }
      return;
    }

    if (view === 'list') {
      if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelectedIdx((i) => Math.min(envs.length, i + 1)); return; }
      if (key.return) {
        if (selectedIdx === envs.length) { openForm(); setView('add'); }
        else { openForm(envs[selectedIdx]); setView('edit'); }
        return;
      }
      if (input === 'a') { openForm(); setView('add'); return; }
      if (input === 'd') {
        const env = envs[selectedIdx];
        if (env) { deleteEnvironment(env.name); refreshEnvs(); setSelectedIdx((i) => Math.max(0, i - 1)); }
        return;
      }
      if (input === ' ') {
        const env = envs[selectedIdx];
        if (env) {
          const newActive = state.activeEnvName === env.name ? null : env.name;
          setActiveEnvironment(newActive);
          dispatch({ type: 'SET_ACTIVE_ENV', name: newActive });
          // If activating and env has a specUrl, load it
          if (newActive && env.specUrl) {
            dispatch({ type: 'LOAD_SPEC', source: env.specUrl });
          }
        }
        return;
      }
    }

    if (view === 'add' || view === 'edit') {
      if (key.tab && !key.shift) { moveFocus(1); return; }
      if (key.tab && key.shift) { moveFocus(-1); return; }
      if (key.upArrow) { moveFocus(-1); return; }
      if (key.downArrow) { moveFocus(1); return; }
      if (key.return) {
        if (focusedField === 'hook') { handleSave(); }
        else { moveFocus(1); }
        return;
      }
    }
  });

  // ── List view ──
  if (view === 'list') {
    return (
      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} width={70}>
          <Text bold color="cyan">{'Environment Manager'}</Text>
          <Text color="gray">{'[↑↓] select  [Enter] edit  [a] add  [d] delete  [Space] activate  [Esc] close'}</Text>

          <Box flexDirection="column" marginTop={1}>
            {envs.length === 0 && (
              <Text color="gray">{'No environments yet. Press [a] to add one.'}</Text>
            )}
            {envs.map((env, i) => {
              const isSelected = i === selectedIdx;
              const isActive = state.activeEnvName === env.name;
              return (
                <Box key={env.name} flexDirection="column">
                  <Box>
                    <Text backgroundColor={isSelected ? 'blue' : undefined}>
                      <Text color={isActive ? 'green' : 'gray'}>{isActive ? '● ' : '○ '}</Text>
                      <Text color="white" bold={isSelected}>{env.name}</Text>
                      <Text color={isSelected ? 'white' : 'gray'}>{' — ' + env.baseUrl}</Text>
                      {env.preRequestHook && <Text color={isSelected ? 'yellow' : 'gray'}>{' ⚡'}</Text>}
                      {env.tokenProvider && <Text color={isSelected ? 'cyan' : 'gray'}>{' 🔑'}</Text>}
                    </Text>
                  </Box>
                  {isSelected && env.specUrl && (
                    <Box paddingLeft={4}>
                      <Text color="gray">{'spec: '}</Text>
                      <Text color="cyan">{env.specUrl}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            <Box>
              <Text
                backgroundColor={selectedIdx === envs.length ? 'blue' : undefined}
                color={selectedIdx === envs.length ? 'white' : 'gray'}
              >
                {'+ Add new environment'}
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  // ── Add / Edit form ──
  const fa = (f: FormField) => focusedField === f;

  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} width={74}>
        <Text bold color="cyan">{view === 'add' ? 'Add Environment' : 'Edit Environment'}</Text>
        <Text color="gray">{'[Tab/↑↓] move  [Enter] next · save on last field  [Esc] cancel'}</Text>

        <Box marginTop={1} flexDirection="column">

          {/* Name */}
          <Box>
            <Text color={fa('name') ? 'cyan' : 'yellow'}>{fa('name') ? '▶ ' : '  '}{'Name:     '}</Text>
            <TextInput value={nameVal} onChange={setNameVal} focus={fa('name')} placeholder={'Production'} />
          </Box>

          {/* Spec URL */}
          <Box marginTop={1}>
            <Text color={fa('specUrl') ? 'cyan' : 'white'}>{fa('specUrl') ? '▶ ' : '  '}{'Spec URL: '}</Text>
            <TextInput value={specUrlVal} onChange={setSpecUrlVal} focus={fa('specUrl')} placeholder={'https://api.example.com/api-docs  (optional)'} />
          </Box>
          {fa('specUrl') && (
            <Box paddingLeft={4}>
              <Text color="gray" dimColor>{'URL or path to load the OpenAPI JSON/YAML spec from'}</Text>
            </Box>
          )}

          {/* Base URL */}
          <Box>
            <Text color={fa('baseUrl') ? 'cyan' : 'yellow'}>{fa('baseUrl') ? '▶ ' : '  '}{'Base URL: '}</Text>
            <TextInput value={baseUrlVal} onChange={setBaseUrlVal} focus={fa('baseUrl')} placeholder={'https://api.example.com'} />
          </Box>
          {fa('baseUrl') && (
            <Box paddingLeft={4}>
              <Text color="gray" dimColor>{'Base URL used for all HTTP requests'}</Text>
            </Box>
          )}

          {/* Headers */}
          <Box marginTop={1}>
            <Text color={fa('headers') ? 'cyan' : 'gray'}>{fa('headers') ? '▶ ' : '  '}{'Headers:  '}</Text>
            <TextInput value={headersVal} onChange={setHeadersVal} focus={fa('headers')} placeholder={'{"Authorization":"Bearer ..."}'} />
          </Box>

          {/* Variables */}
          <Box>
            <Text color={fa('variables') ? 'cyan' : 'gray'}>{fa('variables') ? '▶ ' : '  '}{'Variables:'}</Text>
            <TextInput value={variablesVal} onChange={setVariablesVal} focus={fa('variables')} placeholder={'{"userId":"123"}'} />
          </Box>

          {/* Hook */}
          <Box marginTop={1}>
            <Text color={fa('hook') ? 'cyan' : 'gray'}>{fa('hook') ? '▶ ' : '  '}{'Hook ⚡:  '}</Text>
            <TextInput value={hookVal} onChange={setHookVal} focus={fa('hook')} placeholder={"echo '{\"headers\":{\"Authorization\":\"Bearer ...\"}}'"}/>
          </Box>
          {fa('hook') && (
            <Box paddingLeft={4}>
              <Text color="gray" dimColor>{'stdout JSON: {"headers":{"Key":"value"}}'}</Text>
            </Box>
          )}
        </Box>

        <Box marginTop={1}>
          {focusedField === 'hook' ? (
            <Text backgroundColor="green" color="black">{' [Enter] Save '}</Text>
          ) : (
            <Text color="gray">{'  [Enter] next field  ·  Tab until Hook → Enter to save'}</Text>
          )}
          {(!nameVal.trim() || !baseUrlVal.trim()) && (
            <Text color="red">{'  name & baseUrl required'}</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

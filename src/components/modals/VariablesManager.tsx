import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp, useActiveEnvironment } from '../../context/AppContext.js';
import { saveEnvironment } from '../../lib/config-store.js';

type View = 'list' | 'edit';

export function VariablesManager() {
  const { state, dispatch } = useApp();
  const activeEnv = useActiveEnvironment();

  const [view, setView] = useState<View>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Edit form state
  const [editOriginalName, setEditOriginalName] = useState<string | null>(null); // null = add mode
  const [editName, setEditName] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editField, setEditField] = useState<0 | 1>(0); // 0=name, 1=value

  const entries = activeEnv ? Object.entries(activeEnv.variables) : [];

  const persistVars = (vars: Record<string, string>) => {
    if (!activeEnv) return;
    const updated = { ...activeEnv, variables: vars };
    saveEnvironment(updated);
    dispatch({ type: 'UPDATE_ENV_VARIABLES', envName: activeEnv.name, variables: vars });
  };

  const openAdd = () => {
    setEditOriginalName(null);
    setEditName('');
    setEditValue('');
    setEditField(0);
    setView('edit');
  };

  const openEdit = (name: string, value: string) => {
    setEditOriginalName(name);
    setEditName(name);
    setEditValue(value);
    setEditField(0);
    setView('edit');
  };

  const handleSave = () => {
    const name = editName.trim();
    const value = editValue;
    if (!name || !activeEnv) return;

    const vars = { ...activeEnv.variables };
    // If renaming, remove old key
    if (editOriginalName !== null && editOriginalName !== name) {
      delete vars[editOriginalName];
    }
    vars[name] = value;
    persistVars(vars);

    // Keep selection on the saved item
    const newEntries = Object.entries(vars);
    const newIdx = newEntries.findIndex(([k]) => k === name);
    setSelectedIdx(Math.max(0, newIdx));
    setView('list');
  };

  const handleDelete = () => {
    if (!activeEnv || entries.length === 0) return;
    const [name] = entries[selectedIdx] ?? [];
    if (!name) return;
    const vars = { ...activeEnv.variables };
    delete vars[name];
    persistVars(vars);
    setSelectedIdx((i) => Math.max(0, i - 1));
  };

  useInput((input, key) => {
    if (key.escape) {
      if (view !== 'list') { setView('list'); return; }
      dispatch({ type: 'CLOSE_MODAL' });
      return;
    }

    if (view === 'list') {
      if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelectedIdx((i) => Math.min(entries.length - 1, i + 1)); return; }
      if (input === 'a') { openAdd(); return; }
      if ((input === 'e' || key.return) && entries.length > 0) {
        const [name, value] = entries[selectedIdx] ?? [];
        if (name !== undefined && value !== undefined) openEdit(name, value);
        return;
      }
      if (input === 'd') { handleDelete(); return; }
      return;
    }

    if (view === 'edit') {
      if (key.tab || (key.downArrow && editField === 0) || (key.upArrow && editField === 1)) {
        setEditField((f) => (f === 0 ? 1 : 0));
        return;
      }
      if (key.return) { handleSave(); return; }
      return;
    }
  });

  // ── No active env ──
  if (!activeEnv) {
    return (
      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} width={60}>
          <Text bold color="cyan">{'Variables'}</Text>
          <Text color="gray">{'No active environment.'}</Text>
          <Text color="gray">{'Press [e] to create or activate an environment first.'}</Text>
        </Box>
      </Box>
    );
  }

  // ── Edit / Add form ──
  if (view === 'edit') {
    const isAdd = editOriginalName === null;
    return (
      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} width={70}>
          <Text bold color="cyan">{isAdd ? 'Add Variable' : 'Edit Variable'}</Text>
          <Text color="gray">{'[Tab/↑↓] switch field  [Enter] save  [Esc] cancel'}</Text>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={editField === 0 ? 'cyan' : 'gray'}>{editField === 0 ? '▶ ' : '  '}{'Name:  '}</Text>
              <TextInput
                value={editName}
                onChange={setEditName}
                focus={editField === 0}
                placeholder={'variableName'}
              />
            </Box>
            <Box>
              <Text color={editField === 1 ? 'cyan' : 'gray'}>{editField === 1 ? '▶ ' : '  '}{'Value: '}</Text>
              <TextInput
                value={editValue}
                onChange={setEditValue}
                focus={editField === 1}
                placeholder={'value'}
              />
            </Box>
          </Box>

          <Box marginTop={1}>
            {!editName.trim()
              ? <Text color="red">{'  name is required'}</Text>
              : <Text backgroundColor="green" color="black">{' [Enter] Save '}</Text>
            }
          </Box>
        </Box>
      </Box>
    );
  }

  // ── List view ──
  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} width={74}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">{'Variables'}</Text>
          <Text color="gray">{'env: '}<Text color="green">{activeEnv.name}</Text></Text>
        </Box>
        <Text color="gray">{'[↑↓] navigate  [a] add  [e/Enter] edit  [d] delete  [Esc] close'}</Text>

        <Box flexDirection="column" marginTop={1}>
          {entries.length === 0 && (
            <Text color="gray">{'  No variables yet. Press [a] to add one.'}</Text>
          )}
          {entries.map(([name, value], i) => {
            const isSel = i === selectedIdx;
            const displayVal = value.length > 45 ? value.slice(0, 45) + '…' : value;
            return (
              <Box key={name}>
                <Text backgroundColor={isSel ? 'blue' : undefined}>
                  <Text color={isSel ? 'white' : 'gray'}>{isSel ? '▶ ' : '  '}</Text>
                  <Text color={isSel ? 'cyan' : 'cyan'}>{`{{${name}}}`}</Text>
                  <Text color={isSel ? 'white' : 'gray'}>{`  =  `}</Text>
                  <Text color={isSel ? 'white' : 'gray'}>{`"${displayVal}"`}</Text>
                </Text>
              </Box>
            );
          })}

          <Box marginTop={entries.length > 0 ? 1 : 0}>
            <Text color="gray">{'  + [a] add new variable'}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

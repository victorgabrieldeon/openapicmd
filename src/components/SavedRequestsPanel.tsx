import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp } from '../context/AppContext.js';
import {
  getSavedRequests,
  deleteSavedRequest,
  renameSavedRequest,
  type SavedRequest,
} from '../lib/saved-requests.js';
import { preFillFormCache } from './detail/RequestForm.js';

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':    return 'green';
    case 'POST':   return 'yellow';
    case 'PUT':    return 'blue';
    case 'PATCH':  return 'cyan';
    case 'DELETE': return 'red';
    default:       return 'white';
  }
}

export function SavedRequestsPanel({ height }: { height: number }) {
  const { state, dispatch } = useApp();
  const [entries, setEntries] = useState<SavedRequest[]>(() => getSavedRequests());
  const [cursor, setCursor] = useState(0);
  const [scrollOff, setScrollOff] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null); // id being renamed
  const [renameVal, setRenameVal] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setEntries(getSavedRequests());
    setCursor(0);
    setScrollOff(0);
  }, []);

  const visibleCount = Math.max(1, height - 4);

  const moveCursor = useCallback((dir: 1 | -1) => {
    setCursor((prev) => {
      const next = Math.max(0, Math.min(entries.length - 1, prev + dir));
      setScrollOff((off) => {
        if (next < off) return next;
        if (next >= off + visibleCount) return next - visibleCount + 1;
        return off;
      });
      return next;
    });
  }, [entries.length, visibleCount]);

  const loadEntry = useCallback((entry: SavedRequest) => {
    const endpoint = state.spec?.endpoints.find((e) => e.id === entry.endpointId);
    if (!endpoint) return;
    preFillFormCache(entry.endpointId, {
      pathValues: entry.values.pathParams,
      queryValues: entry.values.queryParams,
      headersStr: Object.keys(entry.values.headers).length > 0
        ? JSON.stringify(entry.values.headers)
        : '',
      bodyFieldValues: entry.bodyFieldValues,
    });
    dispatch({ type: 'SELECT_ENDPOINT', id: entry.endpointId });
    dispatch({ type: 'CLOSE_MODAL_NAVIGATE', panel: 'request' });
  }, [state.spec, dispatch]);

  useInput((input, key) => {
    if (renaming !== null) {
      if (key.return) {
        renameSavedRequest(renaming, renameVal.trim() || renameVal);
        setEntries(getSavedRequests());
        setRenaming(null);
        setRenameVal('');
      } else if (key.escape) {
        setRenaming(null);
        setRenameVal('');
      }
      return;
    }

    if (confirmDelete) {
      if (input === 'y') {
        const entry = entries[cursor];
        if (entry) {
          deleteSavedRequest(entry.id);
          setEntries(getSavedRequests());
          setCursor((prev) => Math.max(0, Math.min(prev, entries.length - 2)));
        }
      }
      setConfirmDelete(false);
      return;
    }

    if (key.escape) { dispatch({ type: 'CLOSE_MODAL' }); return; }
    if (key.upArrow) { moveCursor(-1); return; }
    if (key.downArrow) { moveCursor(1); return; }
    if (key.return) {
      const entry = entries[cursor];
      if (entry) loadEntry(entry);
      return;
    }
    if (input === 'd') {
      if (entries[cursor]) setConfirmDelete(true);
      return;
    }
    if (input === 'r') {
      const entry = entries[cursor];
      if (entry) { setRenaming(entry.id); setRenameVal(entry.name); }
      return;
    }
  });

  const visibleEntries = useMemo(
    () => entries.slice(scrollOff, scrollOff + visibleCount),
    [entries, scrollOff, visibleCount]
  );

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Box marginBottom={1}>
        <Text bold color="cyan">{'SAVED REQUESTS  '}</Text>
        <Text color="gray">{'[↑↓] navigate  [Enter] load  [r] rename  [d] delete  [Esc] close'}</Text>
      </Box>

      {renaming !== null && (
        <Box>
          <Text color="cyan">{'Rename: '}</Text>
          <TextInput value={renameVal} onChange={setRenameVal} focus placeholder="name..." />
          <Text color="gray">{'  [Enter] confirm  [Esc] cancel'}</Text>
        </Box>
      )}

      {confirmDelete && (
        <Box>
          <Text color="red" bold>{'Delete this saved request? '}</Text>
          <Text color="yellow">{'[y] yes  '}</Text>
          <Text color="gray">{'[any] cancel'}</Text>
        </Box>
      )}

      {entries.length === 0 ? (
        <Box>
          <Text color="gray">{'No saved requests yet. Press [s] in the request form to save one.'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleEntries.map((entry, i) => {
            const absIdx = scrollOff + i;
            const isSelected = absIdx === cursor;
            const isInSpec = state.spec?.endpoints.some((e) => e.id === entry.endpointId) ?? false;
            const bg = isSelected ? 'cyan' : undefined;

            const method = entry.method.toUpperCase().padEnd(6);
            const name = entry.name.length > 28 ? entry.name.slice(0, 27) + '…' : entry.name.padEnd(28);
            const path = entry.path.length > 28 ? entry.path.slice(0, 27) + '…' : entry.path;

            return (
              <Box key={entry.id}>
                <Text backgroundColor={bg} color={isSelected ? 'black' : 'white'}>
                  {isSelected ? '▶ ' : '  '}
                  <Text color={isSelected ? 'black' : methodColor(entry.method)}>{method}</Text>
                  {' '}
                  <Text color={isSelected ? 'black' : 'white'} bold>{name}</Text>
                  {' '}
                  <Text color={isSelected ? 'black' : (isInSpec ? 'gray' : 'gray')}>{path}</Text>
                  {entry.envName && <Text color={isSelected ? 'black' : 'gray'}>{`  [${entry.envName}]`}</Text>}
                  {!isInSpec && <Text color={isSelected ? 'black' : 'gray'}>{' (not in spec)'}</Text>}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {scrollOff > 0 && <Text color="gray">{'  ↑ more...'}</Text>}
      {scrollOff + visibleCount < entries.length && <Text color="gray">{'  ↓ more...'}</Text>}
    </Box>
  );
}

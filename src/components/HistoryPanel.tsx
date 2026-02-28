import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp } from '../context/AppContext.js';
import { getHistory, removeFromHistory, clearHistory, relativeTime, type HistoryEntry } from '../lib/history.js';
import { preFillFormCache } from './detail/RequestForm.js';
import { saveRequest } from '../lib/saved-requests.js';

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

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'green';
  if (status >= 400 && status < 500) return 'yellow';
  if (status >= 500) return 'red';
  if (status === 0) return 'red';
  return 'gray';
}

export function HistoryPanel({ height }: { height: number }) {
  const { state, dispatch } = useApp();
  const [entries, setEntries] = useState<HistoryEntry[]>(() => getHistory());
  const [cursor, setCursor] = useState(0);
  const [scrollOff, setScrollOff] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [savingEntry, setSavingEntry] = useState<HistoryEntry | null>(null);
  const [saveNameInput, setSaveNameInput] = useState('');

  // Refresh entries when panel opens
  useEffect(() => {
    setEntries(getHistory());
    setCursor(0);
    setScrollOff(0);
  }, []);

  const visibleCount = Math.max(1, height - 4); // header(2) + hint(1) + padding(1)

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

  const close = useCallback(() => {
    dispatch({ type: 'CLOSE_MODAL' });
  }, [dispatch]);

  const loadEntry = useCallback((entry: HistoryEntry) => {
    // Find endpoint in current spec
    const endpoint = state.spec?.endpoints.find((e) => e.id === entry.endpointId);
    if (!endpoint) return;

    // Pre-fill form cache with saved values
    preFillFormCache(entry.endpointId, {
      pathValues: entry.values.pathParams,
      queryValues: entry.values.queryParams,
      headersStr: Object.keys(entry.values.headers).length > 0
        ? JSON.stringify(entry.values.headers)
        : '',
      bodyFieldValues: entry.bodyFieldValues,
    });

    // Navigate to the endpoint and open request form
    dispatch({ type: 'SELECT_ENDPOINT', id: entry.endpointId });
    dispatch({ type: 'CLOSE_MODAL_NAVIGATE', panel: 'request' });
  }, [state.spec, dispatch]);

  const deleteEntry = useCallback((id: string) => {
    removeFromHistory(id);
    setEntries(getHistory());
    setCursor((prev) => Math.max(0, Math.min(prev, entries.length - 2)));
  }, [entries.length]);

  useInput((input, key) => {
    // Save-as mode
    if (savingEntry !== null) {
      if (key.return) {
        const name = saveNameInput.trim() || `${savingEntry.method.toUpperCase()} ${savingEntry.path}`;
        saveRequest({
          name,
          endpointId: savingEntry.endpointId,
          method: savingEntry.method,
          path: savingEntry.path,
          envName: savingEntry.envName,
          values: savingEntry.values,
          bodyFieldValues: savingEntry.bodyFieldValues,
        });
        setSavingEntry(null);
        setSaveNameInput('');
      } else if (key.escape) {
        setSavingEntry(null);
        setSaveNameInput('');
      }
      return;
    }

    if (confirmClear) {
      if (input === 'y') {
        clearHistory();
        setEntries([]);
        setConfirmClear(false);
      } else {
        setConfirmClear(false);
      }
      return;
    }

    if (key.escape) { close(); return; }
    if (key.upArrow) { moveCursor(-1); return; }
    if (key.downArrow) { moveCursor(1); return; }
    if (key.return) {
      const entry = entries[cursor];
      if (entry) loadEntry(entry);
      return;
    }
    if (input === 'd') {
      const entry = entries[cursor];
      if (entry) deleteEntry(entry.id);
      return;
    }
    if (input === 's') {
      const entry = entries[cursor];
      if (entry) {
        setSavingEntry(entry);
        setSaveNameInput(`${entry.method.toUpperCase()} ${entry.path}`);
      }
      return;
    }
    if (input === 'c') {
      if (entries.length > 0) setConfirmClear(true);
      return;
    }
  });

  const visibleEntries = useMemo(
    () => entries.slice(scrollOff, scrollOff + visibleCount),
    [entries, scrollOff, visibleCount]
  );

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">{'HISTORY  '}</Text>
        {savingEntry !== null ? (
          <Text color="gray">{'[Enter] confirm  [Esc] cancel'}</Text>
        ) : (
          <Text color="gray">{'[↑↓] nav  [Enter] load  [s] save as  [d] delete  [c] clear  [Esc] close'}</Text>
        )}
      </Box>

      {savingEntry !== null && (
        <Box>
          <Text color="cyan">{'Save as: '}</Text>
          <TextInput value={saveNameInput} onChange={setSaveNameInput} focus placeholder="request name..." />
        </Box>
      )}

      {confirmClear && (
        <Box>
          <Text color="red" bold>{'Clear all history? '}</Text>
          <Text color="yellow">{'[y] yes  '}</Text>
          <Text color="gray">{'[any] cancel'}</Text>
        </Box>
      )}

      {entries.length === 0 ? (
        <Box>
          <Text color="gray">{'No requests in history yet. Run a request to save it.'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleEntries.map((entry, i) => {
            const absIdx = scrollOff + i;
            const isSelected = absIdx === cursor;
            const isInSpec = state.spec?.endpoints.some((e) => e.id === entry.endpointId) ?? false;
            const bg = isSelected ? 'cyan' : undefined;
            const fg = isSelected ? 'black' : undefined;

            const method = entry.method.toUpperCase().padEnd(6);
            const path = entry.path.length > 35 ? entry.path.slice(0, 34) + '…' : entry.path.padEnd(35);
            const status = entry.result.error ? '  ERR' : String(entry.result.status).padStart(5);
            const dur = `${entry.result.durationMs}ms`.padStart(7);
            const env = (entry.envName ?? '(none)').slice(0, 8).padEnd(8);
            const time = relativeTime(entry.timestamp).padStart(10);

            return (
              <Box key={entry.id}>
                <Text backgroundColor={bg} color={fg ?? 'white'}>
                  {isSelected ? '▶ ' : '  '}
                  <Text color={isSelected ? 'black' : methodColor(entry.method)}>{method}</Text>
                  {' '}
                  <Text color={isSelected ? 'black' : (isInSpec ? 'white' : 'gray')}>{path}</Text>
                  {' '}
                  <Text color={isSelected ? 'black' : statusColor(entry.result.status)}>{status}</Text>
                  <Text color={isSelected ? 'black' : 'gray'}>{dur}  {env}  {time}</Text>
                  {!isInSpec && <Text color={isSelected ? 'black' : 'gray'}>{' (not in spec)'}</Text>}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Scroll indicators */}
      {scrollOff > 0 && (
        <Text color="gray">{'  ↑ more...'}</Text>
      )}
      {scrollOff + visibleCount < entries.length && (
        <Text color="gray">{'  ↓ more...'}</Text>
      )}
    </Box>
  );
}

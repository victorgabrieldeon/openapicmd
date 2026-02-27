import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RequestResult } from '../../types/openapi.js';
import { copyToClipboard } from '../../lib/clipboard.js';

interface ResponseViewProps {
  result: RequestResult;
  height?: number;
  isFocused?: boolean;
  onFullView?: () => void;
}

function formatBody(body: unknown): string {
  if (body === null || body === undefined) return '(empty)';
  if (typeof body === 'string') return body.slice(0, 3000);
  try {
    return JSON.stringify(body, null, 2).slice(0, 3000);
  } catch {
    return String(body);
  }
}

export function ResponseView({ result, height = 12, isFocused = true, onFullView }: ResponseViewProps) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const handleCopy = useCallback(async () => {
    if (!result.curlCommand) return;
    const ok = await copyToClipboard(result.curlCommand);
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  }, [result.curlCommand]);

  useInput((input, key) => {
    if (!isFocused) return;
    if (input === 'c' && result.curlCommand) { void handleCopy(); return; }
    if (input === 'f' && onFullView && !result.error) { onFullView(); return; }
  });

  const statusColor =
    result.status >= 200 && result.status < 300
      ? 'green'
      : result.status >= 400 && result.status < 500
      ? 'yellow'
      : result.status >= 500
      ? 'red'
      : 'gray';

  const bodyText = result.error ? `Error: ${result.error}` : formatBody(result.body);
  // Reserve 2 lines for the header bar + 1 for copy hint
  const bodyLines = bodyText.split('\n').slice(0, Math.max(1, height - 3));
  const truncated = bodyText.split('\n').length > height - 3;

  return (
    <Box flexDirection="column" borderStyle="single" borderTop paddingX={1}>
      {/* Status bar */}
      <Box justifyContent="space-between">
        <Box>
          <Text bold color={statusColor}>
            {`RESPONSE ${result.status} ${result.statusText}`}
          </Text>
          <Text color="gray">{` — ${result.durationMs}ms`}</Text>
        </Box>
        <Box>
          {copyState === 'ok' && <Text color="green">{'✓ Copied!'}</Text>}
          {copyState === 'fail' && <Text color="red">{'✗ Copy failed'}</Text>}
          {copyState === 'idle' && (
            <Box>
              {!result.error && onFullView && <Text color="gray">{'[f] Full view  '}</Text>}
              {result.curlCommand && <Text color="gray">{'[c] cURL'}</Text>}
            </Box>
          )}
        </Box>
      </Box>

      {/* Body */}
      {result.error ? (
        <Text color="red">{result.error}</Text>
      ) : (
        <Box flexDirection="column">
          {bodyLines.map((line, i) => (
            <Text key={i} wrap="truncate">{line}</Text>
          ))}
          {truncated && <Text color="gray">{'... (truncated)'}</Text>}
        </Box>
      )}
    </Box>
  );
}

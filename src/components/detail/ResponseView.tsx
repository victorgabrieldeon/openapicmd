import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RequestResult } from '../../types/openapi.js';
import { copyToClipboard } from '../../lib/clipboard.js';

interface ResponseViewProps {
  result: RequestResult;
  height?: number;
  isFocused?: boolean;
  onFullView?: () => void;
  onRepeat?: () => void;
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

export function ResponseView({ result, height = 12, isFocused = true, onFullView, onRepeat }: ResponseViewProps) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail' | 'body-ok' | 'body-fail'>('idle');

  const handleCopyCurl = useCallback(async () => {
    if (!result.curlCommand) return;
    const ok = await copyToClipboard(result.curlCommand);
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  }, [result.curlCommand]);

  const handleCopyBody = useCallback(async () => {
    if (result.body === null || result.body === undefined) return;
    const text = typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body, null, 2);
    const ok = await copyToClipboard(text);
    setCopyState(ok ? 'body-ok' : 'body-fail');
    setTimeout(() => setCopyState('idle'), 2000);
  }, [result.body]);

  useInput((input, key) => {
    if (!isFocused) return;
    if (input === 'c' && result.curlCommand) { void handleCopyCurl(); return; }
    if (input === 'b' && result.body !== null && result.body !== undefined) { void handleCopyBody(); return; }
    if (input === 'r' && onRepeat) { onRepeat(); return; }
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
          {copyState === 'ok' && <Text color="green">{'✓ cURL copied!'}</Text>}
          {copyState === 'fail' && <Text color="red">{'✗ Copy failed'}</Text>}
          {copyState === 'body-ok' && <Text color="green">{'✓ Body copied!'}</Text>}
          {copyState === 'body-fail' && <Text color="red">{'✗ Copy failed'}</Text>}
          {copyState === 'idle' && (
            <Box>
              {!result.error && onFullView && <Text color="gray">{'[f] full  '}</Text>}
              {onRepeat && <Text color="gray">{'[r] repeat  '}</Text>}
              {result.body !== null && result.body !== undefined && !result.error && <Text color="gray">{'[b] body  '}</Text>}
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

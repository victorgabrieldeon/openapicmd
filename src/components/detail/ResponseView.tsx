import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import type { RequestResult } from '../../types/openapi.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { detectNextPageUrl, detectNextCursor } from '../../lib/pagination.js';

interface ResponseViewProps {
  result: RequestResult;
  height?: number;
  isFocused?: boolean;
  onFullView?: () => void;
  onRepeat?: () => void;
  onNextUrl?: (url: string) => void;
  onNextCursor?: (queryParam: string, value: string) => void;
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

export function ResponseView({ result, height = 12, isFocused = true, onFullView, onRepeat, onNextUrl, onNextCursor }: ResponseViewProps) {
  type FeedbackState = 'idle' | 'ok' | 'fail' | 'body-ok' | 'body-fail' | 'export-ok' | 'export-fail';
  const [feedback, setFeedback] = useState<FeedbackState>('idle');
  const [exportFilename, setExportFilename] = useState('');

  const nextUrl = useMemo(() => detectNextPageUrl(result.body), [result.body]);
  const nextCursor = useMemo(() => detectNextCursor(result.body), [result.body]);
  const hasNext = !result.error && Boolean(nextUrl ?? nextCursor);

  const handleCopyCurl = useCallback(async () => {
    if (!result.curlCommand) return;
    const ok = await copyToClipboard(result.curlCommand);
    setFeedback(ok ? 'ok' : 'fail');
    setTimeout(() => setFeedback('idle'), 2000);
  }, [result.curlCommand]);

  const handleCopyBody = useCallback(async () => {
    if (result.body === null || result.body === undefined) return;
    const text = typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body, null, 2);
    const ok = await copyToClipboard(text);
    setFeedback(ok ? 'body-ok' : 'body-fail');
    setTimeout(() => setFeedback('idle'), 2000);
  }, [result.body]);

  const handleExport = useCallback(() => {
    if (result.body === null || result.body === undefined) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `response_${ts}.json`;
    const content = typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body, null, 2);
    try {
      fs.writeFileSync(filename, content, 'utf-8');
      setExportFilename(filename);
      setFeedback('export-ok');
    } catch {
      setFeedback('export-fail');
    }
    setTimeout(() => setFeedback('idle'), 3000);
  }, [result.body]);

  useInput((input, key) => {
    if (!isFocused) return;
    if (input === 'c' && result.curlCommand) { void handleCopyCurl(); return; }
    if (input === 'b' && result.body !== null && result.body !== undefined) { void handleCopyBody(); return; }
    if (input === 'r' && onRepeat) { onRepeat(); return; }
    if (input === 'f' && onFullView && !result.error) { onFullView(); return; }
    if (input === 'x' && result.body !== null && result.body !== undefined && !result.error) { handleExport(); return; }
    if (input === 'n' && hasNext) {
      if (nextUrl && onNextUrl) { onNextUrl(nextUrl); return; }
      if (nextCursor && onNextCursor) { onNextCursor(nextCursor.queryParam, nextCursor.value); return; }
    }
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
          {feedback === 'ok'          && <Text color="green">{'✓ cURL copied!'}</Text>}
          {feedback === 'fail'        && <Text color="red">{'✗ Copy failed'}</Text>}
          {feedback === 'body-ok'     && <Text color="green">{'✓ Body copied!'}</Text>}
          {feedback === 'body-fail'   && <Text color="red">{'✗ Copy failed'}</Text>}
          {feedback === 'export-ok'   && <Text color="green">{`✓ Saved ${exportFilename}`}</Text>}
          {feedback === 'export-fail' && <Text color="red">{'✗ Export failed'}</Text>}
          {feedback === 'idle' && (
            <Box>
              {!result.error && onFullView && <Text color="gray">{'[f] full  '}</Text>}
              {onRepeat && <Text color="gray">{'[r] repeat  '}</Text>}
              {hasNext && (onNextUrl ?? onNextCursor) && <Text color="cyan">{'[n] next page  '}</Text>}
              {result.body !== null && result.body !== undefined && !result.error && <Text color="gray">{'[b] body  [x] export  '}</Text>}
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

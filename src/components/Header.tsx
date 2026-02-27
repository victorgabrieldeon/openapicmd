import React from 'react';
import { Box, Text } from 'ink';
import { useApp, useActiveEnvironment } from '../context/AppContext.js';
import { hasTokenCached } from '../lib/executor.js';

export function Header() {
  const { state } = useApp();
  const activeEnv = useActiveEnvironment();

  const rawSpecLabel = state.specSource ?? activeEnv?.specUrl ?? null;
  const specLabel = rawSpecLabel
    ? rawSpecLabel.length > 36
      ? '...' + rawSpecLabel.slice(-33)
      : rawSpecLabel
    : 'No spec';

  const envLabel = activeEnv ? activeEnv.name : 'No env';
  const title = state.spec?.title ? ` | ${state.spec.title} v${state.spec.version}` : '';

  const hasProvider = Boolean(activeEnv?.tokenProvider);
  const tokenCached = activeEnv ? hasTokenCached(activeEnv.name) : false;

  return (
    <Box borderStyle="single" borderBottom paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">
        {'openapicmd-tui'}
        <Text color="white">{title}</Text>
      </Text>
      <Box>
        <Text color="yellow">{'Spec: '}</Text>
        <Text>{specLabel}</Text>
        <Text color="yellow">{'  Env: '}</Text>
        <Text color={activeEnv ? 'green' : 'gray'}>{envLabel}</Text>
        {hasProvider && (
          <Text>
            <Text color="gray">{'  '}</Text>
            {tokenCached
              ? <Text color="green">{'⚡✓'}</Text>
              : <Text color="yellow">{'⚡'}</Text>}
          </Text>
        )}
      </Box>
    </Box>
  );
}

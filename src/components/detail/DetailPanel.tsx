import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useApp, useSelectedEndpoint, useActiveEnvironment } from '../../context/AppContext.js';
import { EndpointInfo } from './EndpointInfo.js';
import { RequestForm } from './RequestForm.js';

interface DetailPanelProps {
  height: number;
}

export function DetailPanel({ height }: DetailPanelProps) {
  const { state, dispatch } = useApp();
  const endpoint = useSelectedEndpoint();
  const activeEnv = useActiveEnvironment();
  // Fallback baseUrl: spec's first server, or empty string
  const specBaseUrl = state.spec?.servers[0] ?? '';

  const isDetailFocused = state.activePanel === 'detail';
  const isRequestFocused = state.activePanel === 'request';

  useInput((input, key) => {
    if (!isDetailFocused) return;
    if (input === 'r' && endpoint) {
      dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'request' });
    }
    if (input === 't' && endpoint) {
      dispatch({ type: 'OPEN_MODAL', modal: 'token-provider' });
    }
  });

  if (!endpoint) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} height={height}>
        <Text color="gray">{'Select an endpoint from the sidebar'}</Text>
        <Text color="gray">{'Use ↑↓ to navigate, Enter to select'}</Text>
      </Box>
    );
  }

  if (isRequestFocused) {
    return (
      <RequestForm
        endpoint={endpoint}
        env={activeEnv}
        fallbackBaseUrl={specBaseUrl}
        onClose={() => dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'detail' })}
        height={height}
      />
    );
  }

  return (
    <Box flexDirection="column" height={height}>
      <EndpointInfo endpoint={endpoint} />

      {isDetailFocused && (
        <Box paddingX={1} marginTop={1}>
          <Text color="gray">{'[r] Execute request  [t] Token provider'}</Text>
        </Box>
      )}
    </Box>
  );
}

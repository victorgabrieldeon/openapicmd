import React, { useEffect } from 'react';
import { Box, Text, useApp as useInkApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useApp, useActiveEnvironment } from '../context/AppContext.js';
import { useSpec } from '../hooks/useSpec.js';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { Sidebar } from './sidebar/Sidebar.js';
import { DetailPanel } from './detail/DetailPanel.js';
import { LoadSpec } from './modals/LoadSpec.js';
import { EnvManager } from './modals/EnvManager.js';
import { TokenProviderModal } from './modals/TokenProvider.js';
import { HistoryPanel } from './HistoryPanel.js';

export function App() {
  const { state, dispatch } = useApp();
  const { exit } = useInkApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 120;

  // Load spec if source was provided via CLI
  useSpec(state.specSource);

  useInput((input, key) => {
    // Block global shortcuts whenever a TextInput has focus
    if (
      state.activePanel === 'modal' ||
      state.activePanel === 'request' ||
      state.sidebarSearchActive
    ) return;

    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'o') {
      dispatch({ type: 'OPEN_MODAL', modal: 'load-spec' });
      return;
    }
    if (input === 'e') {
      dispatch({ type: 'OPEN_MODAL', modal: 'env-manager' });
      return;
    }
    if (input === 'h') {
      dispatch({ type: 'OPEN_MODAL', modal: 'history' });
      return;
    }
    if (key.tab) {
      if (state.activePanel === 'sidebar') {
        dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'detail' });
      } else if (state.activePanel === 'detail') {
        dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'sidebar' });
      }
      return;
    }
    if (key.rightArrow && state.activePanel === 'sidebar') {
      dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'detail' });
      return;
    }
    if (key.leftArrow && state.activePanel === 'detail') {
      dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'sidebar' });
      return;
    }
  });

  // Main content height = terminal height minus header (3) and footer (3)
  const contentHeight = Math.max(10, termHeight - 6);
  const sidebarWidth = 26;

  if (state.activeModal === 'load-spec') {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header />
        <LoadSpec />
        <Footer />
      </Box>
    );
  }

  if (state.activeModal === 'env-manager') {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header />
        <EnvManager />
        <Footer />
      </Box>
    );
  }

  if (state.activeModal === 'token-provider') {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header />
        <TokenProviderModal />
        <Footer />
      </Box>
    );
  }

  if (state.activeModal === 'history') {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header />
        <HistoryPanel height={contentHeight} />
        <Footer />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header />
      <Box flexGrow={1} height={contentHeight}>
        {state.specLoading ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text>
              <Text color="cyan">
                <Spinner type="dots" />
              </Text>
              {' Loading spec...'}
            </Text>
          </Box>
        ) : state.specError ? (
          <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
            <Text color="red" bold>{'Error loading spec'}</Text>
            <Text color="red">{state.specError}</Text>
            <Text color="gray">{'Press [o] to load a different spec'}</Text>
          </Box>
        ) : !state.spec ? (
          <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
            <Text bold color="cyan">{'Welcome to openapicmd-tui'}</Text>
            <Text color="gray">{'Press [o] to open an OpenAPI spec'}</Text>
            <Text color="gray">{'or pass a file/URL as argument: openapicmd-tui ./spec.yaml'}</Text>
          </Box>
        ) : (
          <>
            <Box width={sidebarWidth} height={contentHeight} borderStyle="single" borderRight>
              <Sidebar height={contentHeight} />
            </Box>
            <Box flexGrow={1} height={contentHeight}>
              <DetailPanel height={contentHeight} />
            </Box>
          </>
        )}
      </Box>
      <Footer />
    </Box>
  );
}

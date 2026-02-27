import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { useApp } from '../context/AppContext.js';

interface KeyHint {
  key: string;
  label: string;
}

function Hint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Box marginRight={1}>
      <Text color="cyan">{`[${keyName}]`}</Text>
      <Text>{` ${label}`}</Text>
    </Box>
  );
}

export function Footer() {
  const { state } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const contextHints: KeyHint[] =
    state.activePanel === 'sidebar'
      ? [{ key: '↵', label: 'Select' }, { key: '→', label: 'Detail' }]
      : state.activePanel === 'detail'
      ? [{ key: 'r', label: 'Request' }, { key: '←', label: 'Back' }]
      : state.activePanel === 'request'
      ? [{ key: 'Esc', label: 'Cancel' }]
      : state.activePanel === 'modal'
      ? [{ key: 'Esc', label: 'Close' }]
      : [];

  const globalHints: KeyHint[] = [
    { key: '↑↓', label: 'Nav' },
    { key: 'Tab', label: 'Switch' },
    { key: 'o', label: 'Spec' },
    { key: 'e', label: 'Env' },
    { key: 'q', label: 'Quit' },
  ];

  const hints = [...contextHints, ...globalHints];

  return (
    <Box borderStyle="single" borderTop paddingX={1} width={width}>
      {hints.map((h) => (
        <Hint key={h.key} keyName={h.key} label={h.label} />
      ))}
    </Box>
  );
}

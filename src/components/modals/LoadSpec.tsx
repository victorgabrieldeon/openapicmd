import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp } from '../../context/AppContext.js';
import { getConfig } from '../../lib/config-store.js';

type FocusMode = 'input' | 'recents';

export function LoadSpec() {
  const { dispatch } = useApp();
  const config = getConfig();
  const recentSpecs = config.recentSpecs.slice(0, 8);

  const [value, setValue] = useState('');
  const [focusMode, setFocusMode] = useState<FocusMode>('input');
  const [recentIdx, setRecentIdx] = useState(0);

  const handleLoad = (source: string) => {
    const trimmed = source.trim();
    if (!trimmed) return;
    dispatch({ type: 'CLOSE_MODAL' });
    dispatch({ type: 'LOAD_SPEC', source: trimmed });
  };

  useInput((input, key) => {
    if (key.escape) {
      if (focusMode === 'recents') {
        setFocusMode('input');
      } else {
        dispatch({ type: 'CLOSE_MODAL' });
      }
      return;
    }

    if (focusMode === 'input') {
      // ↓ from input → enter recents list (only if there are recents)
      if (key.downArrow && recentSpecs.length > 0) {
        setFocusMode('recents');
        setRecentIdx(0);
        return;
      }
      // Enter handled by TextInput's onSubmit
    }

    if (focusMode === 'recents') {
      if (key.upArrow) {
        if (recentIdx === 0) {
          // Back to text input
          setFocusMode('input');
        } else {
          setRecentIdx((i) => i - 1);
        }
        return;
      }
      if (key.downArrow) {
        setRecentIdx((i) => Math.min(recentSpecs.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const spec = recentSpecs[recentIdx];
        if (spec) handleLoad(spec);
        return;
      }
    }
  });

  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        width={64}
      >
        <Text bold color="cyan">{'Open OpenAPI Spec'}</Text>

        {/* Text input */}
        <Box marginTop={1}>
          <Text color={focusMode === 'input' ? 'cyan' : 'gray'}>{'▶ '}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleLoad}
            focus={focusMode === 'input'}
            placeholder={'./petstore.yaml  or  https://...'}
          />
        </Box>

        {/* Recent specs */}
        {recentSpecs.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">{'Recent:'}</Text>
            {recentSpecs.map((spec, i) => {
              const isSelected = focusMode === 'recents' && i === recentIdx;
              const label = spec.length > 54 ? '...' + spec.slice(-51) : spec;
              return (
                <Box key={spec}>
                  <Text
                    backgroundColor={isSelected ? 'blue' : undefined}
                    color={isSelected ? 'white' : 'gray'}
                  >
                    {isSelected ? '▶ ' : `  `}
                    {`${i + 1}. `}
                    <Text color={isSelected ? 'white' : 'white'}>{label}</Text>
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text color="gray">
            {'[Enter] Load  [↓] Recent specs  [↑] Back to input  [Esc] Cancel'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

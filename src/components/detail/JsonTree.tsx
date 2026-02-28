import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useApp, useActiveEnvironment } from '../../context/AppContext.js';
import { saveEnvironment } from '../../lib/config-store.js';

type NodeData = {
  path: string;
  key: string;
  value: unknown;
  depth: number;
  isExpandable: boolean;
  childCount: number;
};

function buildVisible(
  value: unknown,
  key: string,
  depth: number,
  path: string,
  collapsed: Set<string>
): NodeData[] {
  const isArr = Array.isArray(value);
  const isObj = !isArr && value !== null && typeof value === 'object';
  const childCount = isArr
    ? (value as unknown[]).length
    : isObj
    ? Object.keys(value as object).length
    : 0;
  const isExpandable = (isArr || isObj) && childCount > 0;

  const node: NodeData = { path, key, value, depth, isExpandable, childCount };
  const result: NodeData[] = [node];

  if (isExpandable && !collapsed.has(path)) {
    if (isArr) {
      (value as unknown[]).forEach((v, i) =>
        result.push(...buildVisible(v, `[${i}]`, depth + 1, `${path}[${i}]`, collapsed))
      );
    } else {
      Object.entries(value as Record<string, unknown>).forEach(([k, v]) =>
        result.push(...buildVisible(v, k, depth + 1, `${path}.${k}`, collapsed))
      );
    }
  }

  return result;
}

function nodeValueToString(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function ValueLabel({ node, isCollapsed, isSelected }: {
  node: NodeData;
  isCollapsed: boolean;
  isSelected: boolean;
}) {
  const dim = isSelected ? 'black' : undefined;
  const { value, isExpandable, childCount } = node;

  if (!isExpandable) {
    if (value === null) return <Text color={isSelected ? 'black' : 'red'}>{'null'}</Text>;
    if (typeof value === 'boolean') return <Text color={isSelected ? 'black' : 'magenta'}>{String(value)}</Text>;
    if (typeof value === 'number') return <Text color={isSelected ? 'black' : 'yellow'}>{String(value)}</Text>;
    if (typeof value === 'string') {
      const display = value.length > 100 ? value.slice(0, 100) + '…' : value;
      return <Text color={isSelected ? 'black' : 'green'}>{`"${display}"`}</Text>;
    }
    return <Text color={dim}>{String(value)}</Text>;
  }

  const isArr = Array.isArray(value);
  if (isCollapsed) {
    return isArr
      ? <Text color={isSelected ? 'black' : 'gray'}>{`[ ${childCount} items ]`}</Text>
      : <Text color={isSelected ? 'black' : 'gray'}>{`{ ${childCount} keys }`}</Text>;
  }
  return isArr
    ? <Text color={isSelected ? 'black' : 'gray'}>{'['}</Text>
    : <Text color={isSelected ? 'black' : 'gray'}>{'{'}</Text>;
}

interface JsonTreeProps {
  body: unknown;
  height: number;
  isFocused: boolean;
  onClose: () => void;
}

export function JsonTree({ body, height, isFocused, onClose }: JsonTreeProps) {
  const { dispatch } = useApp();
  const activeEnv = useActiveEnvironment();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [scrollOff, setScrollOff] = useState(0);

  // Capture state
  const [capturing, setCapturing] = useState(false);
  const [captureVarName, setCaptureVarName] = useState('');
  const [captureStatus, setCaptureStatus] = useState<'idle' | 'ok' | 'notfound'>('idle');
  const [captureMsg, setCaptureMsg] = useState('');

  const nodes = useMemo(
    () => buildVisible(body, 'root', 0, 'root', collapsed),
    [body, collapsed]
  );

  // 2 lines: path bar + hint bar
  const visibleCount = Math.max(1, height - 2);

  const moveCursor = useCallback((dir: 1 | -1) => {
    setCursor(prev => {
      const next = Math.max(0, Math.min(nodes.length - 1, prev + dir));
      setScrollOff(off => {
        if (next < off) return next;
        if (next >= off + visibleCount) return next - visibleCount + 1;
        return off;
      });
      return next;
    });
  }, [nodes.length, visibleCount]);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useInput((input, key) => {
    if (!isFocused) return;

    if (capturing) {
      if (key.escape) {
        setCapturing(false);
        setCaptureVarName('');
        return;
      }
      if (key.return) {
        if (!captureVarName.trim() || !activeEnv) return;
        const node = nodes[cursor];
        if (!node) return;
        const value = nodeValueToString(node.value);
        const newVars = { ...activeEnv.variables, [captureVarName.trim()]: value };
        saveEnvironment({ ...activeEnv, variables: newVars });
        dispatch({ type: 'UPDATE_ENV_VARIABLES', envName: activeEnv.name, variables: newVars });
        const display = value.length > 40 ? value.slice(0, 40) + '…' : value;
        setCaptureMsg(`✓ {{${captureVarName.trim()}}} = "${display}"`);
        setCaptureStatus('ok');
        setCapturing(false);
        setCaptureVarName('');
        setTimeout(() => setCaptureStatus('idle'), 2500);
        return;
      }
      if (key.backspace || key.delete) {
        setCaptureVarName(s => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setCaptureVarName(s => s + input);
      }
      return;
    }

    // Normal navigation
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { moveCursor(-1); return; }
    if (key.downArrow) { moveCursor(1); return; }

    const node = nodes[cursor];
    if (!node) return;

    if (key.return || input === ' ') {
      if (node.isExpandable) toggleCollapse(node.path);
      return;
    }
    if (key.leftArrow) {
      if (node.isExpandable && !collapsed.has(node.path)) {
        toggleCollapse(node.path);
      } else if (node.depth > 0) {
        for (let i = cursor - 1; i >= 0; i--) {
          if (nodes[i]!.depth < node.depth) {
            const diff = cursor - i;
            for (let d = 0; d < diff; d++) moveCursor(-1);
            break;
          }
        }
      }
      return;
    }
    if (key.rightArrow) {
      if (node.isExpandable && collapsed.has(node.path)) {
        toggleCollapse(node.path);
      }
      return;
    }
    if (input === 'v' && activeEnv) {
      setCapturing(true);
      setCaptureVarName('');
      return;
    }
  });

  const visibleNodes = nodes.slice(scrollOff, scrollOff + visibleCount);
  const currentNode = nodes[cursor];

  // Bottom 2 lines: path bar + hint bar
  const pathBar = capturing ? (
    <Box>
      <Text color="cyan">{'  Variable name: '}</Text>
      <Text>{captureVarName}</Text>
      <Text color="cyan">{'_'}</Text>
    </Box>
  ) : captureStatus === 'ok' ? (
    <Box>
      <Text color="green">{'  '}{captureMsg}</Text>
    </Box>
  ) : (
    <Box>
      <Text color="gray" wrap="truncate">
        {'  '}{currentNode?.path ?? ''}
      </Text>
    </Box>
  );

  const hintBar = capturing ? (
    <Box>
      <Text color="gray">{'  [Enter] save  [Esc] cancel'}</Text>
    </Box>
  ) : (
    <Box>
      <Text color="gray">{'  [↑↓] move  [Enter/Space] toggle  [←] collapse/parent  [→] expand'}</Text>
      {activeEnv && <Text color="gray">{'  [v] capture'}</Text>}
      <Text color="gray">{'  [Esc] close'}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" height={height}>
      {/* Tree rows */}
      <Box flexDirection="column">
        {visibleNodes.map((node, i) => {
          const absIdx = scrollOff + i;
          const isSelected = absIdx === cursor;
          const isCollapsed = collapsed.has(node.path);
          const indent = '  '.repeat(node.depth);
          const arrow = node.isExpandable
            ? (isCollapsed ? '▶ ' : '▼ ')
            : '  ';

          const keyColor = isSelected ? 'black' : 'cyan';

          return (
            <Box key={node.path + absIdx}>
              <Text backgroundColor={isSelected ? 'cyan' : undefined}>
                {indent}
                <Text color={isSelected ? 'black' : 'white'}>{arrow}</Text>
                {node.depth > 0
                  ? <Text color={keyColor}>{node.key}</Text>
                  : <Text color={keyColor}>{'root'}</Text>}
                <Text color={isSelected ? 'black' : 'gray'}>{': '}</Text>
                <ValueLabel node={node} isCollapsed={isCollapsed} isSelected={isSelected} />
              </Text>
            </Box>
          );
        })}
      </Box>

      {pathBar}
      {hintBar}
    </Box>
  );
}

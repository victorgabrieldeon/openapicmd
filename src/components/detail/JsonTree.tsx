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

function nodeMatchesQuery(node: NodeData, q: string): boolean {
  if (!q) return false;
  if (node.key.toLowerCase().includes(q)) return true;
  if (!node.isExpandable) {
    if (typeof node.value === 'string') return node.value.toLowerCase().includes(q);
    if (typeof node.value === 'number' || typeof node.value === 'boolean') return String(node.value).includes(q);
  }
  return false;
}

function ValueLabel({ node, isCollapsed, isHighlighted }: {
  node: NodeData;
  isCollapsed: boolean;
  isHighlighted: boolean;  // true for selected or search match
}) {
  const { value, isExpandable, childCount } = node;

  if (!isExpandable) {
    if (value === null) return <Text color={isHighlighted ? 'black' : 'red'}>{'null'}</Text>;
    if (typeof value === 'boolean') return <Text color={isHighlighted ? 'black' : 'magenta'}>{String(value)}</Text>;
    if (typeof value === 'number') return <Text color={isHighlighted ? 'black' : 'yellow'}>{String(value)}</Text>;
    if (typeof value === 'string') {
      const display = value.length > 100 ? value.slice(0, 100) + '…' : value;
      return <Text color={isHighlighted ? 'black' : 'green'}>{`"${display}"`}</Text>;
    }
    return <Text color={isHighlighted ? 'black' : undefined}>{String(value)}</Text>;
  }

  const isArr = Array.isArray(value);
  if (isCollapsed) {
    return isArr
      ? <Text color={isHighlighted ? 'black' : 'gray'}>{`[ ${childCount} items ]`}</Text>
      : <Text color={isHighlighted ? 'black' : 'gray'}>{`{ ${childCount} keys }`}</Text>;
  }
  return isArr
    ? <Text color={isHighlighted ? 'black' : 'gray'}>{'['}</Text>
    : <Text color={isHighlighted ? 'black' : 'gray'}>{'{'}</Text>;
}

/** Convert a JsonTree internal path ("root.fields[0].id") to a resolvePathArray
 *  lookup path ("fields[].id"). Array indices are replaced with []. */
export function treePathToLookupPath(treePath: string): string {
  let p = treePath === 'root' ? '' :
           treePath.startsWith('root.') ? treePath.slice(5) :
           treePath.startsWith('root[') ? treePath.slice(4) : treePath;
  return p.replace(/\[\d+\]/g, '[]');
}

interface JsonTreeProps {
  body: unknown;
  height: number;
  isFocused: boolean;
  onClose: () => void;
  /** Called when the user presses Enter on a leaf node. Receives the lookup-format path. */
  onSelect?: (path: string) => void;
}

export function JsonTree({ body, height, isFocused, onClose, onSelect }: JsonTreeProps) {
  const { dispatch } = useApp();
  const activeEnv = useActiveEnvironment();

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [scrollOff, setScrollOff] = useState(0);

  // Capture state
  const [capturing, setCapturing] = useState(false);
  const [captureVarName, setCaptureVarName] = useState('');
  const [captureStatus, setCaptureStatus] = useState<'idle' | 'ok'>('idle');
  const [captureMsg, setCaptureMsg] = useState('');

  // Search state
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);

  const nodes = useMemo(
    () => buildVisible(body, 'root', 0, 'root', collapsed),
    [body, collapsed]
  );

  // 2 lines: path/status bar + hint bar
  const visibleCount = Math.max(1, height - 2);

  // Compute which node indices match the search query
  const matchIndices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return nodes.reduce<number[]>((acc, node, i) => {
      if (nodeMatchesQuery(node, q)) acc.push(i);
      return acc;
    }, []);
  }, [nodes, searchQuery]);

  const jumpCursor = useCallback((idx: number) => {
    setCursor(idx);
    setScrollOff(off => {
      if (idx < off) return idx;
      if (idx >= off + visibleCount) return idx - visibleCount + 1;
      return off;
    });
  }, [visibleCount]);

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

  const goToNextMatch = useCallback((dir: 1 | -1) => {
    if (matchIndices.length === 0) return;
    setSearchMatchIdx(prev => {
      const next = (prev + dir + matchIndices.length) % matchIndices.length;
      jumpCursor(matchIndices[next]!);
      return next;
    });
  }, [matchIndices, jumpCursor]);

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

    // ── Capture mode ──
    if (capturing) {
      if (key.escape) { setCapturing(false); setCaptureVarName(''); return; }
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
      if (key.backspace || key.delete) { setCaptureVarName(s => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setCaptureVarName(s => s + input); }
      return;
    }

    // ── Search input mode ──
    if (searching) {
      if (key.escape) {
        setSearchQuery('');
        setSearching(false);
        return;
      }
      if (key.return || input === 'n') {
        // Confirm query and jump to first match
        setSearching(false);
        if (matchIndices.length > 0) {
          setSearchMatchIdx(0);
          jumpCursor(matchIndices[0]!);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery(s => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const newQ = searchQuery + input;
        setSearchQuery(newQ);
        // Live jump to first match as user types
        const q = newQ.trim().toLowerCase();
        if (q) {
          const firstMatch = nodes.findIndex(n => nodeMatchesQuery(n, q));
          if (firstMatch >= 0) {
            setSearchMatchIdx(0);
            jumpCursor(firstMatch);
          }
        }
      }
      return;
    }

    // ── Normal navigation ──
    if (key.escape) {
      if (searchQuery) { setSearchQuery(''); setSearchMatchIdx(0); return; }
      onClose();
      return;
    }
    if (key.upArrow) { moveCursor(-1); return; }
    if (key.downArrow) { moveCursor(1); return; }

    // Search triggers
    if (input === '/') {
      setSearching(true);
      setSearchQuery('');
      setSearchMatchIdx(0);
      return;
    }

    // Navigate matches (only when there is an active query)
    if (input === 'n' && searchQuery && matchIndices.length > 0) {
      goToNextMatch(1);
      return;
    }
    if (input === 'N' && searchQuery && matchIndices.length > 0) {
      goToNextMatch(-1);
      return;
    }

    const node = nodes[cursor];
    if (!node) return;

    if (key.return || input === ' ') {
      if (node.isExpandable) {
        toggleCollapse(node.path);
      } else if (onSelect && key.return) {
        onSelect(treePathToLookupPath(node.path));
      }
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
      if (node.isExpandable && collapsed.has(node.path)) toggleCollapse(node.path);
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
  const matchSet = useMemo(() => new Set(matchIndices), [matchIndices]);

  // ── Bottom bars ──
  let pathBar: React.ReactNode;
  if (capturing) {
    pathBar = (
      <Box>
        <Text color="cyan">{'  Variable name: '}</Text>
        <Text>{captureVarName}</Text>
        <Text color="cyan">{'_'}</Text>
      </Box>
    );
  } else if (captureStatus === 'ok') {
    pathBar = <Box><Text color="green">{'  '}{captureMsg}</Text></Box>;
  } else if (searching) {
    pathBar = (
      <Box>
        <Text color="cyan">{'  /'}</Text>
        <Text color="white">{searchQuery}</Text>
        <Text color="cyan">{'_'}</Text>
        {matchIndices.length > 0 && (
          <Text color="green">{`  ${matchIndices.length} match${matchIndices.length === 1 ? '' : 'es'}`}</Text>
        )}
        {searchQuery.trim() && matchIndices.length === 0 && (
          <Text color="red">{'  no matches'}</Text>
        )}
      </Box>
    );
  } else if (searchQuery) {
    const pos = matchIndices.length > 0 ? `${searchMatchIdx + 1}/${matchIndices.length}` : '0/0';
    pathBar = (
      <Box>
        <Text color="yellow">{'  /'}</Text>
        <Text color="yellow">{searchQuery}</Text>
        <Text color="gray">{`  ${pos}`}</Text>
        <Text color="gray" wrap="truncate">{'  '}{currentNode?.path ?? ''}</Text>
      </Box>
    );
  } else {
    pathBar = (
      <Box>
        <Text color="gray" wrap="truncate">{'  '}{currentNode?.path ?? ''}</Text>
      </Box>
    );
  }

  let hintBar: React.ReactNode;
  if (capturing) {
    hintBar = <Box><Text color="gray">{'  [Enter] save  [Esc] cancel'}</Text></Box>;
  } else if (searching) {
    hintBar = <Box><Text color="gray">{'  type to search keys & values  [Enter] confirm  [Esc] cancel'}</Text></Box>;
  } else if (searchQuery && matchIndices.length > 0) {
    hintBar = (
      <Box>
        <Text color="gray">{'  [n] next  [N] prev  [/] new search  [Esc] clear'}</Text>
        {activeEnv && <Text color="gray">{'  [v] capture'}</Text>}
        <Text color="gray">{'  [Esc×2] close'}</Text>
      </Box>
    );
  } else if (onSelect) {
    const isLeaf = currentNode && !currentNode.isExpandable;
    hintBar = (
      <Box>
        <Text color="gray">{'  [↑↓] move  [Space] toggle  [←] collapse  [→] expand  [/] search'}</Text>
        {isLeaf
          ? <Text color="cyan">{'  [Enter] select path'}</Text>
          : <Text color="gray">{'  (navigate to a value to select)'}</Text>}
        <Text color="gray">{'  [Esc] back'}</Text>
      </Box>
    );
  } else {
    hintBar = (
      <Box>
        <Text color="gray">{'  [↑↓] move  [Enter/Space] toggle  [←] collapse  [→] expand  [/] search'}</Text>
        {activeEnv && <Text color="gray">{'  [v] capture'}</Text>}
        <Text color="gray">{'  [Esc] close'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={height}>
      {/* Tree rows */}
      <Box flexDirection="column">
        {visibleNodes.map((node, i) => {
          const absIdx = scrollOff + i;
          const isSelected = absIdx === cursor;
          const isMatch = matchSet.has(absIdx) && Boolean(searchQuery);
          const isHighlighted = isSelected || isMatch;
          const isCollapsed = collapsed.has(node.path);
          const indent = '  '.repeat(node.depth);
          const arrow = node.isExpandable
            ? (isCollapsed ? '▶ ' : '▼ ')
            : '  ';

          const bg = isSelected ? 'cyan' : isMatch ? 'yellow' : undefined;

          return (
            <Box key={node.path + absIdx}>
              <Text backgroundColor={bg}>
                {indent}
                <Text color={isHighlighted ? 'black' : 'white'}>{arrow}</Text>
                {node.depth > 0
                  ? <Text color={isHighlighted ? 'black' : 'cyan'}>{node.key}</Text>
                  : <Text color={isHighlighted ? 'black' : 'cyan'}>{'root'}</Text>}
                <Text color={isHighlighted ? 'black' : 'gray'}>{': '}</Text>
                <ValueLabel node={node} isCollapsed={isCollapsed} isHighlighted={isHighlighted} />
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

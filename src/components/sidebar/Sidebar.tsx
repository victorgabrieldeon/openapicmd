import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useApp } from '../../context/AppContext.js';
import { TagGroupHeader } from './TagGroup.js';
import { EndpointItem } from './EndpointItem.js';
import type { HttpMethod } from '../../types/openapi.js';

type FlatItem =
  | { type: 'tag'; tagName: string }
  | { type: 'endpoint'; endpointId: string; method: string; path: string; tagName: string; summary?: string };

interface SidebarProps {
  height: number;
}

export function Sidebar({ height }: SidebarProps) {
  const { state, dispatch } = useApp();
  const isFocused = state.activePanel === 'sidebar';

  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string | null>(null);
  const searchActive = state.sidebarSearchActive;
  const setSearchActive = (active: boolean) =>
    dispatch({ type: 'SET_SIDEBAR_SEARCH', active });

  // Build full flat list (respects expanded/collapsed tags)
  const allFlatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const group of state.tagGroups) {
      items.push({ type: 'tag', tagName: group.name });
      if (group.isExpanded) {
        for (const ep of group.endpoints) {
          items.push({
            type: 'endpoint',
            endpointId: ep.id,
            method: ep.method,
            path: ep.path,
            tagName: group.name,
            summary: ep.summary,
          });
        }
      }
    }
    return items;
  }, [state.tagGroups]);

  // Filter by search query + method filter — tags only shown when they have matching children
  const flatItems = useMemo<FlatItem[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const mf = methodFilter;
    if (!q && !mf) return allFlatItems;

    const matchingTags = new Set<string>();
    const filteredItems: FlatItem[] = [];

    // First pass: find all matching endpoints
    for (const item of allFlatItems) {
      if (item.type === 'endpoint') {
        const methodMatch = !mf || item.method.toLowerCase() === mf;
        const textMatch = !q || (
          item.path.toLowerCase().includes(q) ||
          item.method.toLowerCase().includes(q) ||
          (item.summary?.toLowerCase().includes(q) ?? false) ||
          item.tagName.toLowerCase().includes(q)
        );
        if (methodMatch && textMatch) matchingTags.add(item.tagName);
      }
    }

    // Second pass: include tag headers + matching endpoints
    for (const item of allFlatItems) {
      if (item.type === 'tag') {
        if (matchingTags.has(item.tagName)) filteredItems.push(item);
      } else {
        const methodMatch = !mf || item.method.toLowerCase() === mf;
        const textMatch = !q || (
          item.path.toLowerCase().includes(q) ||
          item.method.toLowerCase().includes(q) ||
          (item.summary?.toLowerCase().includes(q) ?? false) ||
          item.tagName.toLowerCase().includes(q)
        );
        if (methodMatch && textMatch) filteredItems.push(item);
      }
    }

    return filteredItems;
  }, [allFlatItems, searchQuery, methodFilter]);

  const totalItems = flatItems.length;
  // height - 1 (title) - 1 (search bar) - 1 padding
  const visibleHeight = Math.max(1, height - 3);
  const currentIndex = Math.min(state.sidebarIndex, Math.max(0, totalItems - 1));

  const scrollOffset = useMemo(() => {
    const half = Math.floor(visibleHeight / 2);
    const raw = currentIndex - half;
    return Math.max(0, Math.min(raw, Math.max(0, totalItems - visibleHeight)));
  }, [currentIndex, visibleHeight, totalItems]);

  const visibleItems = flatItems.slice(scrollOffset, scrollOffset + visibleHeight);

  useInput((input, key) => {
    if (!isFocused) return;

    // --- Search active mode ---
    if (searchActive) {
      if (key.escape) {
        setSearchQuery('');
        setSearchActive(false);
        if (methodFilter) setMethodFilter(null);
        return;
      }
      // Up/Down still navigate the list while searching
      if (key.upArrow) {
        const newIndex = Math.max(0, currentIndex - 1);
        dispatch({ type: 'SET_SIDEBAR_INDEX', index: newIndex });
        const item = flatItems[newIndex];
        if (item?.type === 'endpoint') dispatch({ type: 'SELECT_ENDPOINT', id: item.endpointId });
        return;
      }
      if (key.downArrow) {
        const newIndex = Math.min(totalItems - 1, currentIndex + 1);
        dispatch({ type: 'SET_SIDEBAR_INDEX', index: newIndex });
        const item = flatItems[newIndex];
        if (item?.type === 'endpoint') dispatch({ type: 'SELECT_ENDPOINT', id: item.endpointId });
        return;
      }
      if (key.return) {
        const item = flatItems[currentIndex];
        if (!item) { setSearchActive(false); return; }
        if (item.type === 'tag') {
          dispatch({ type: 'TOGGLE_TAG', tagName: item.tagName });
        } else {
          dispatch({ type: 'SELECT_ENDPOINT', id: item.endpointId });
          dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'detail' });
          setSearchActive(false);
        }
        return;
      }
      // All other keys (characters) go to TextInput — don't handle here
      return;
    }

    // --- Normal navigation mode ---
    if (input === '/') {
      setSearchActive(true);
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
      return;
    }
    if (key.upArrow) {
      const newIndex = Math.max(0, currentIndex - 1);
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: newIndex });
      const item = flatItems[newIndex];
      if (item?.type === 'endpoint') dispatch({ type: 'SELECT_ENDPOINT', id: item.endpointId });
    } else if (key.downArrow) {
      const newIndex = Math.min(totalItems - 1, currentIndex + 1);
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: newIndex });
      const item = flatItems[newIndex];
      if (item?.type === 'endpoint') dispatch({ type: 'SELECT_ENDPOINT', id: item.endpointId });
    } else if (key.return) {
      const item = flatItems[currentIndex];
      if (!item) return;
      if (item.type === 'tag') {
        dispatch({ type: 'TOGGLE_TAG', tagName: item.tagName });
      } else {
        dispatch({ type: 'SELECT_ENDPOINT', id: item.endpointId });
        dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'detail' });
      }
    } else if (input === 'r' && state.selectedEndpointId) {
      dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'request' });
    } else if (input === 'g') {
      setMethodFilter((f) => f === 'get' ? null : 'get');
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
    } else if (input === 'p') {
      setMethodFilter((f) => f === 'post' ? null : 'post');
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
    } else if (input === 'u') {
      setMethodFilter((f) => f === 'put' ? null : 'put');
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
    } else if (input === 'd') {
      setMethodFilter((f) => f === 'delete' ? null : 'delete');
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
    } else if (input === 'x') {
      setMethodFilter((f) => f === 'patch' ? null : 'patch');
      dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
    }
  });

  const endpointCount = state.spec?.endpoints.length ?? 0;
  const filteredCount = flatItems.filter((i) => i.type === 'endpoint').length;
  const isFiltered = Boolean(searchQuery || methodFilter);

  if (!state.spec) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="gray">{'No spec loaded'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Title */}
      <Box>
        <Text bold color={isFocused ? 'cyan' : 'white'}>
          {isFiltered
            ? `ENDPOINTS (${filteredCount}/${endpointCount})`
            : `ENDPOINTS (${endpointCount})`}
        </Text>
        {methodFilter && (
          <Text color="cyan" bold>{` [${methodFilter.toUpperCase()}]`}</Text>
        )}
      </Box>

      {/* Search bar */}
      <Box>
        <Text color={searchActive ? 'cyan' : 'gray'}>{'/'}</Text>
        {searchActive ? (
          <TextInput
            value={searchQuery}
            onChange={(v) => {
              setSearchQuery(v);
              dispatch({ type: 'SET_SIDEBAR_INDEX', index: 0 });
            }}
            focus={searchActive}
            placeholder={'filter endpoints...'}
          />
        ) : searchQuery ? (
          <Text color="yellow">{searchQuery}<Text color="gray">{' [Esc]'}</Text></Text>
        ) : (
          <Text color="gray">{'search'}</Text>
        )}
      </Box>

      {/* Endpoint list */}
      {totalItems === 0 && searchQuery ? (
        <Text color="gray">{'No matches'}</Text>
      ) : (
        visibleItems.map((item, visIdx) => {
          const absIdx = visIdx + scrollOffset;
          const isSelected = absIdx === currentIndex;

          if (item.type === 'tag') {
            const group = state.tagGroups.find((g) => g.name === item.tagName);
            return (
              <TagGroupHeader
                key={`tag-${item.tagName}`}
                name={item.tagName}
                isExpanded={group?.isExpanded ?? true}
                isSelected={isSelected}
              />
            );
          }

          return (
            <Box key={item.endpointId} paddingLeft={1}>
              <EndpointItem
                method={item.method as HttpMethod}
                path={item.path}
                isSelected={isSelected || item.endpointId === state.selectedEndpointId}
                maxWidth={22}
              />
            </Box>
          );
        })
      )}
    </Box>
  );
}

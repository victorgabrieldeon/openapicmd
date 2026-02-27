import React from 'react';
import { Box, Text } from 'ink';
import type { HttpMethod } from '../../types/openapi.js';

const METHOD_COLORS: Record<HttpMethod, string> = {
  get: 'green',
  post: 'blue',
  put: 'yellow',
  patch: 'magenta',
  delete: 'red',
  head: 'gray',
  options: 'gray',
  trace: 'gray',
};

interface EndpointItemProps {
  method: HttpMethod;
  path: string;
  isSelected: boolean;
  maxWidth?: number;
}

export function EndpointItem({ method, path, isSelected, maxWidth = 22 }: EndpointItemProps) {
  const color = METHOD_COLORS[method] ?? 'white';
  const methodLabel = method.toUpperCase().padEnd(7);
  // Truncate path to fit sidebar
  const availableWidth = maxWidth - 8; // 8 for method + space
  const displayPath = path.length > availableWidth ? path.slice(0, availableWidth - 1) + '…' : path;

  return (
    <Box>
      <Text backgroundColor={isSelected ? 'blue' : undefined} color={isSelected ? 'white' : undefined}>
        <Text color={isSelected ? 'white' : color}>{methodLabel}</Text>
        <Text color={isSelected ? 'white' : 'white'}>{displayPath}</Text>
      </Text>
    </Box>
  );
}

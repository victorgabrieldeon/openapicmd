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
  // Truncate path to fit sidebar (method is 7 chars via padEnd(7))
  const availableWidth = maxWidth - 7;
  const displayPath = path.length > availableWidth ? path.slice(0, availableWidth - 1) + '…' : path;

  return (
    <Box>
      <Text wrap="truncate" backgroundColor={isSelected ? 'blue' : undefined} color={isSelected ? 'white' : undefined}>
        <Text color={isSelected ? 'white' : color}>{methodLabel}</Text>
        <Text wrap="truncate" color={isSelected ? 'white' : 'white'}>{displayPath}</Text>
      </Text>
    </Box>
  );
}

import React from 'react';
import { Box, Text } from 'ink';

interface TagGroupHeaderProps {
  name: string;
  isExpanded: boolean;
  isSelected: boolean;
}

export function TagGroupHeader({ name, isExpanded, isSelected }: TagGroupHeaderProps) {
  return (
    <Box>
      <Text
        backgroundColor={isSelected ? 'blue' : undefined}
        color={isSelected ? 'white' : 'yellow'}
        bold
      >
        {isExpanded ? '▼ ' : '▶ '}
        {name}
      </Text>
    </Box>
  );
}

import React from 'react';
import { Box, Text } from 'ink';
import type { Endpoint } from '../../types/openapi.js';

const METHOD_COLORS: Record<string, string> = {
  get: 'green',
  post: 'blue',
  put: 'yellow',
  patch: 'magenta',
  delete: 'red',
  head: 'gray',
  options: 'gray',
  trace: 'gray',
};

interface EndpointInfoProps {
  endpoint: Endpoint;
}

type FieldInfo = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  indent: number;
};

function getFieldType(schema: Record<string, unknown>): string {
  // oneOf with null → pick the non-null type (NestJS nullable pattern)
  if (schema['oneOf']) {
    const variants = schema['oneOf'] as Record<string, unknown>[];
    const nonNull = variants.find((v) => v['type'] !== 'null');
    if (nonNull) return getFieldType(nonNull) + '?';
    return 'any?';
  }
  if (schema['type'] === 'array') {
    const items = schema['items'] as Record<string, unknown> | undefined;
    const itemType = items ? getFieldType(items) : 'any';
    return itemType + '[]';
  }
  if (schema['type']) return schema['type'] as string;
  if (schema['$ref']) return ((schema['$ref'] as string).split('/').pop() ?? 'object');
  if (schema['allOf'] || schema['anyOf']) return 'object';
  return 'any';
}

function extractFields(schema: Record<string, unknown>, indent = 0, maxDepth = 2): FieldInfo[] {
  // allOf — merge all sub-schemas (common in NestJS)
  if (schema['allOf']) {
    return (schema['allOf'] as Record<string, unknown>[]).flatMap((s) =>
      extractFields(s, indent, maxDepth)
    );
  }

  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];

  const required = (schema['required'] as string[]) ?? [];
  const fields: FieldInfo[] = [];

  for (const [name, fieldSchema] of Object.entries(properties)) {
    const isRequired = required.includes(name);
    const type = getFieldType(fieldSchema);

    fields.push({
      name,
      type,
      required: isRequired,
      description: fieldSchema['description'] as string | undefined,
      indent,
    });

    // Recurse into nested objects (up to maxDepth)
    if (indent < maxDepth) {
      const effectiveSchema = fieldSchema['allOf']
        ? { allOf: fieldSchema['allOf'] }
        : fieldSchema;

      const isObject =
        effectiveSchema['type'] === 'object' ||
        Boolean(effectiveSchema['properties']) ||
        Boolean(effectiveSchema['allOf']);

      // For arrays, recurse into items if they're objects
      if (effectiveSchema['type'] === 'array') {
        const items = effectiveSchema['items'] as Record<string, unknown> | undefined;
        if (items && (items['type'] === 'object' || items['properties'] || items['allOf'])) {
          fields.push(...extractFields(items, indent + 1, maxDepth));
        }
      } else if (isObject) {
        fields.push(...extractFields(effectiveSchema as Record<string, unknown>, indent + 1, maxDepth));
      }
    }
  }

  return fields;
}

export function EndpointInfo({ endpoint }: EndpointInfoProps) {
  const methodColor = METHOD_COLORS[endpoint.method] ?? 'white';

  const bodyFields = endpoint.requestBody?.schema
    ? extractFields(endpoint.requestBody.schema)
    : [];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box marginBottom={0}>
        <Text bold color={methodColor}>{endpoint.method.toUpperCase()}</Text>
        <Text bold>{' ' + endpoint.path}</Text>
      </Box>

      {endpoint.summary && (
        <Box marginTop={0}>
          <Text color="gray">{'Summary: '}</Text>
          <Text>{endpoint.summary}</Text>
        </Box>
      )}

      {endpoint.description && endpoint.description !== endpoint.summary && (
        <Box>
          <Text color="gray" wrap="wrap">{endpoint.description.slice(0, 200)}</Text>
        </Box>
      )}

      {endpoint.parameters.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">{'Parameters:'}</Text>
          {endpoint.parameters.map((p) => (
            <Box key={`${p.in}:${p.name}`} paddingLeft={1}>
              <Text color={p.required ? 'white' : 'gray'}>
                {p.name}
                {p.required ? <Text color="red">{'*'}</Text> : ''}
                {' '}
              </Text>
              <Text color="gray">{'('}</Text>
              <Text color="yellow">{p.in}</Text>
              <Text color="gray">{', '}</Text>
              <Text color="cyan">{p.type}</Text>
              <Text color="gray">{')'}</Text>
              {p.description && (
                <Text color="gray">{' — ' + p.description.slice(0, 60)}</Text>
              )}
            </Box>
          ))}
        </Box>
      )}

      {endpoint.requestBody && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="cyan">{'Request Body  '}</Text>
            <Text color="yellow">{endpoint.requestBody.contentType}</Text>
            {endpoint.requestBody.required && <Text color="red">{'  *required'}</Text>}
          </Box>
          {bodyFields.map((f, i) => {
            const indent = f.indent;
            const prefix = indent === 0 ? '  ' : '  ' + '  '.repeat(indent) + '↳ ';
            return (
              <Box key={`${f.name}-${i}`}>
                <Text color="gray">{prefix}</Text>
                <Text color={f.required ? 'white' : 'gray'}>
                  {f.name}
                  {f.required ? <Text color="red">{'*'}</Text> : ''}
                  {' '}
                </Text>
                <Text color="gray">{'('}</Text>
                <Text color={indent > 0 ? 'yellow' : 'cyan'}>{f.type}</Text>
                <Text color="gray">{')'}</Text>
                {f.description && (
                  <Text color="gray">{' — ' + f.description.slice(0, 60)}</Text>
                )}
              </Box>
            );
          })}
          {bodyFields.length === 0 && endpoint.requestBody.schema && (
            <Box paddingLeft={1}>
              <Text color="gray">{'('}</Text>
              <Text color="cyan">{getFieldType(endpoint.requestBody.schema)}</Text>
              <Text color="gray">{')'}</Text>
            </Box>
          )}
        </Box>
      )}

      {endpoint.operationId && (
        <Box marginTop={1}>
          <Text color="gray">{'operationId: '}</Text>
          <Text color="magenta">{endpoint.operationId}</Text>
        </Box>
      )}
    </Box>
  );
}

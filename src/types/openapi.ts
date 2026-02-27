export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace';

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  type: string;
  description?: string;
  schema?: Record<string, unknown>;
  default?: string;
}

export interface Endpoint {
  id: string; // `${method}:${path}`
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: Parameter[];
  requestBody?: {
    required: boolean;
    contentType: string;
    schema?: Record<string, unknown>;
  };
  operationId?: string;
}

export interface TagGroup {
  name: string;
  endpoints: Endpoint[];
  isExpanded: boolean;
}

export interface ParsedSpec {
  title: string;
  version: string;
  description?: string;
  servers: string[];
  endpoints: Endpoint[];
  tagGroups: TagGroup[];
}

export interface RequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
  error?: string;
  curlCommand?: string;
  /** Set when the token provider failed to fetch/inject the token */
  tokenError?: string;
}

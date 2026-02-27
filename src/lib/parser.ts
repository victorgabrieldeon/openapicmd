import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV2, OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import type { Endpoint, Parameter, ParsedSpec, TagGroup, HttpMethod } from '../types/openapi.js';

type Document = OpenAPI.Document;

function isV2(doc: Document): doc is OpenAPIV2.Document {
  return 'swagger' in doc;
}

function isV3(doc: Document): doc is OpenAPIV3.Document | OpenAPIV3_1.Document {
  return 'openapi' in doc;
}

function normalizeParameters(
  params: (OpenAPIV2.Parameter | OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject)[] = []
): Parameter[] {
  return params.map((p) => {
    const param = p as Record<string, unknown>;
    let type = 'string';
    let defaultValue: string | undefined;
    if (param['schema'] && typeof param['schema'] === 'object') {
      const schema = param['schema'] as Record<string, unknown>;
      type = (schema['type'] as string) ?? 'string';
      if (schema['default'] !== undefined) {
        defaultValue = String(schema['default']);
      }
    } else if (param['type']) {
      type = param['type'] as string;
    }
    // OpenAPI 2.x default at param level
    if (defaultValue === undefined && param['default'] !== undefined) {
      defaultValue = String(param['default']);
    }
    return {
      name: param['name'] as string,
      in: param['in'] as Parameter['in'],
      required: Boolean(param['required']),
      type,
      description: param['description'] as string | undefined,
      schema: param['schema'] as Record<string, unknown> | undefined,
      default: defaultValue,
    };
  });
}

function extractRequestBody(
  operation: Record<string, unknown>
): Endpoint['requestBody'] | undefined {
  // OpenAPI 3.x
  if (operation['requestBody']) {
    const rb = operation['requestBody'] as Record<string, unknown>;
    const content = (rb['content'] as Record<string, unknown>) ?? {};
    const contentType = Object.keys(content)[0] ?? 'application/json';
    const schema = content[contentType]
      ? ((content[contentType] as Record<string, unknown>)['schema'] as Record<string, unknown>)
      : undefined;
    return {
      required: Boolean(rb['required']),
      contentType,
      schema,
    };
  }
  // OpenAPI 2.x body param
  const params = (operation['parameters'] as Record<string, unknown>[]) ?? [];
  const bodyParam = params.find((p) => p['in'] === 'body');
  if (bodyParam) {
    return {
      required: Boolean(bodyParam['required']),
      contentType: 'application/json',
      schema: bodyParam['schema'] as Record<string, unknown> | undefined,
    };
  }
  return undefined;
}

function buildTagGroups(endpoints: Endpoint[]): TagGroup[] {
  const tagMap = new Map<string, Endpoint[]>();
  for (const ep of endpoints) {
    const tags = ep.tags.length > 0 ? ep.tags : ['default'];
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(ep);
    }
  }
  return Array.from(tagMap.entries()).map(([name, eps]) => ({
    name,
    endpoints: eps,
    isExpanded: true,
  }));
}

export async function parseSpec(source: string): Promise<ParsedSpec> {
  let api: Document;
  try {
    api = await SwaggerParser.validate(source);
  } catch {
    // Validation failed (e.g. non-standard schema types) — fall back to dereference without strict validation
    api = await SwaggerParser.dereference(source);
  }

  const endpoints: Endpoint[] = [];
  const paths = api.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    const methods: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

    for (const method of methods) {
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object') continue;

      const op = operation as Record<string, unknown>;
      const pathParams = normalizeParameters(
        (pathItem as Record<string, unknown>)['parameters'] as (OpenAPIV2.Parameter | OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject)[]
      );
      const opParams = normalizeParameters(
        (op['parameters'] as (OpenAPIV2.Parameter | OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject)[]) ?? []
      );

      // Merge path-level and operation-level params (operation overrides)
      const paramMap = new Map<string, Parameter>();
      for (const p of [...pathParams, ...opParams]) {
        paramMap.set(`${p.in}:${p.name}`, p);
      }

      const tags = Array.isArray(op['tags']) ? (op['tags'] as string[]) : [];

      endpoints.push({
        id: `${method}:${path}`,
        method,
        path,
        summary: op['summary'] as string | undefined,
        description: op['description'] as string | undefined,
        tags,
        parameters: Array.from(paramMap.values()).filter((p) => (p.in as string) !== 'body'),
        requestBody: extractRequestBody(op),
        operationId: op['operationId'] as string | undefined,
      });
    }
  }

  const info = api.info;
  let servers: string[] = [];

  if (isV2(api)) {
    const v2 = api as OpenAPIV2.Document;
    const scheme = v2.schemes?.[0] ?? 'https';
    const host = v2.host ?? 'localhost';
    const basePath = v2.basePath ?? '';
    servers = [`${scheme}://${host}${basePath}`];
  } else if (isV3(api)) {
    const v3 = api as OpenAPIV3.Document;
    servers = (v3.servers ?? []).map((s) => s.url);
  }

  return {
    title: info.title,
    version: info.version,
    description: info.description,
    servers,
    endpoints,
    tagGroups: buildTagGroups(endpoints),
  };
}

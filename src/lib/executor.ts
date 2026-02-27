import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Endpoint } from '../types/openapi.js';
import type { Environment, TokenProvider } from '../types/config.js';
import type { RequestResult } from '../types/openapi.js';

const execAsync = promisify(exec);

export interface RequestValues {
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

// ── In-memory token cache (cleared on env change or manual clear) ──
const tokenCache = new Map<string, string>();

export function clearTokenCache(envName: string): void {
  tokenCache.delete(envName);
}

export function hasTokenCached(envName: string): boolean {
  return tokenCache.has(envName);
}

// ── Helpers ──

function buildUrl(baseUrl: string, path: string, pathParams: Record<string, string>): string {
  let resolvedPath = path;
  for (const [key, value] of Object.entries(pathParams)) {
    if (value.trim()) resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value));
  }
  return baseUrl.replace(/\/$/, '') + resolvedPath;
}

/** Extract a value from a nested object using dot-notation path.
 *  If path is empty, the response body itself is treated as the token. */
function extractByPath(obj: unknown, path: string): string | null {
  const trimmed = path.trim();
  // Empty path → body is the token directly (e.g. API returns a plain string)
  if (!trimmed) {
    if (obj === null || obj === undefined) return null;
    return typeof obj === 'string' ? obj : null;
  }
  const parts = trimmed.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === null || cur === undefined) return null;
  return typeof cur === 'string' ? cur : JSON.stringify(cur);
}

/** Run the pre-request shell hook and return any headers it emits. */
async function runHook(hook: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execAsync(hook, { timeout: 10000 });
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed['headers'] && typeof parsed['headers'] === 'object') {
      return parsed['headers'] as Record<string, string>;
    }
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') flat[k] = v;
    }
    return flat;
  } catch {
    return {};
  }
}

export interface TokenTestResult {
  token: string | null;
  status: number;
  responseBody: unknown;
  networkError?: string;
}

/** Fetch a token and return debug info (status + raw response body). */
export async function testTokenProvider(
  provider: TokenProvider,
  baseUrl: string,
  envName: string
): Promise<TokenTestResult> {
  try {
    const url = buildUrl(baseUrl, provider.path, {});
    let body: unknown = undefined;
    if (provider.body.trim()) {
      try { body = JSON.parse(provider.body); } catch { body = provider.body; }
    }

    const resp: AxiosResponse = await axios({
      method: provider.method,
      url,
      headers: { 'Content-Type': 'application/json', ...provider.extraHeaders },
      data: body,
      timeout: 15000,
      validateStatus: () => true,
    });

    const token = extractByPath(resp.data, provider.tokenPath);
    if (token) tokenCache.set(envName, token);

    return { token, status: resp.status, responseBody: resp.data };
  } catch (err) {
    return {
      token: null,
      status: 0,
      responseBody: null,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Fetch a token using the configured TokenProvider and cache it. */
export async function fetchToken(
  provider: TokenProvider,
  baseUrl: string,
  envName: string
): Promise<string | null> {
  const result = await testTokenProvider(provider, baseUrl, envName);
  return result.token;
}

/** Resolve the bearer token — from cache or by fetching fresh. */
async function resolveToken(provider: TokenProvider, env: Environment): Promise<string | null> {
  const cached = tokenCache.get(env.name);
  if (cached) return cached;
  return fetchToken(provider, env.baseUrl, env.name);
}

// ── Main entry ──

export async function executeRequest(
  endpoint: Endpoint,
  values: RequestValues,
  env: Environment | null,
  fallbackBaseUrl = ''
): Promise<RequestResult> {
  const baseUrl = env?.baseUrl ?? fallbackBaseUrl;
  const url = buildUrl(baseUrl, endpoint.path, values.pathParams);

  // Layer 1: static env headers (lowest priority)
  const headers: Record<string, string> = { ...(env?.headers ?? {}) };

  // Layer 2: shell hook headers
  if (env?.preRequestHook) {
    const hookHeaders = await runHook(env.preRequestHook);
    Object.assign(headers, hookHeaders);
  }

  // Layer 3: per-request headers typed in the form
  Object.assign(headers, values.headers);

  // Layer 4: token provider — ALWAYS wins, applied last so nothing overrides it
  if (env?.tokenProvider) {
    const token = await resolveToken(env.tokenProvider, env);
    if (token) {
      const headerName = env.tokenProvider.headerName || 'Authorization';
      const prefix = env.tokenProvider.prefix ?? 'Bearer ';
      headers[headerName] = `${prefix}${token}`;
    }
  }

  let data: unknown = undefined;
  if (values.body?.trim()) {
    try {
      data = JSON.parse(values.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = endpoint.requestBody?.contentType ?? 'application/json';
      }
    } catch {
      data = values.body;
    }
  }

  // Drop empty query params — don't send keys with no value
  const filledQuery = Object.fromEntries(
    Object.entries(values.queryParams).filter(([, v]) => v.trim() !== '')
  );
  const queryParams = Object.keys(filledQuery).length > 0 ? filledQuery : undefined;

  const config: AxiosRequestConfig = {
    method: endpoint.method,
    url,
    headers,
    params: queryParams,
    data,
    timeout: 30000,
    validateStatus: () => true,
  };

  const curlCommand = buildCurl(endpoint.method, url, headers, queryParams, data);

  const start = Date.now();
  try {
    const response: AxiosResponse = await axios(config);
    const durationMs = Date.now() - start;

    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      responseHeaders[k] = String(v);
    }

    return { status: response.status, statusText: response.statusText, headers: responseHeaders, body: response.data, durationMs, curlCommand };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { status: 0, statusText: 'Network Error', headers: {}, body: null, durationMs, error: message, curlCommand };
  }
}

function buildCurl(
  method: string,
  url: string,
  headers: Record<string, string>,
  queryParams: Record<string, string> | undefined,
  data: unknown
): string {
  const parts: string[] = [`curl -X ${method.toUpperCase()}`];

  for (const [k, v] of Object.entries(headers)) {
    // Escape single quotes inside header values
    const safe = v.replace(/'/g, `'\\''`);
    parts.push(`  -H '${k}: ${safe}'`);
  }

  if (data !== undefined && data !== null) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const safe = body.replace(/'/g, `'\\''`);
    parts.push(`  -d '${safe}'`);
  }

  let finalUrl = url;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(queryParams).toString();
    finalUrl += '?' + qs;
  }
  parts.push(`  '${finalUrl}'`);

  return parts.join(' \\\n');
}

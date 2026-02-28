export interface ParsedCurl {
  method: string;
  url: string;
  origin: string;       // https://api.example.com
  path: string;         // /users/123
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  bodyJson: Record<string, unknown> | null;
}

// Split into tokens respecting single and double quotes
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('http') ;
}

/** Extract path params from a URL path using an endpoint path template.
 *  e.g. template "/users/{id}" + path "/users/42" → { id: "42" } */
export function extractPathParams(template: string, urlPath: string): Record<string, string> {
  const names: string[] = [];
  const regexStr = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    names.push(name);
    return '([^/?#]+)';
  });
  try {
    const match = urlPath.match(new RegExp(`^${regexStr}(?:[?#].*)?$`));
    if (!match) return {};
    return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
  } catch {
    return {};
  }
}

export function parseCurl(raw: string): ParsedCurl | null {
  // Normalize: collapse backslash-newlines and strip leading "curl"
  const normalized = raw
    .replace(/\\\r?\n/g, ' ')  // multi-line continuation
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized.startsWith('curl')) return null;

  const tokens = tokenize(normalized.slice(4).trim()); // drop "curl"

  let method = 'GET';
  let url = '';
  const headers: Record<string, string> = {};
  let body: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (t === '-X' || t === '--request') {
      method = (tokens[++i] ?? 'GET').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const hdr = tokens[++i] ?? '';
      const colon = hdr.indexOf(':');
      if (colon > 0) {
        const key = hdr.slice(0, colon).trim().toLowerCase();
        const val = hdr.slice(colon + 1).trim();
        headers[key] = val;
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') {
      body = tokens[++i] ?? null;
    } else if (t === '--json') {
      // curl --json implies POST + Content-Type
      body = tokens[++i] ?? null;
      if (method === 'GET') method = 'POST';
    } else if (!t.startsWith('-') && isUrl(t)) {
      url = t;
    }
    // skip unknown flags and their values
    else if (t.startsWith('--') || (t.startsWith('-') && t.length === 2)) {
      i++; // skip value of unknown flag
    }
  }

  if (!url) return null;

  // Parse URL
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return null;
  }

  const origin = urlObj.origin;
  const path = urlObj.pathname;
  const queryParams: Record<string, string> = {};
  urlObj.searchParams.forEach((v, k) => { queryParams[k] = v; });

  // Try to parse body as JSON
  let bodyJson: Record<string, unknown> | null = null;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bodyJson = parsed as Record<string, unknown>;
      }
    } catch { /* not JSON */ }
  }

  // Infer method from body if still GET
  if (method === 'GET' && body) method = 'POST';

  return { method, url, origin, path, queryParams, headers, body, bodyJson };
}

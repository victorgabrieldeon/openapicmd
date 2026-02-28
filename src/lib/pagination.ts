export interface NextCursor {
  queryParam: string;
  value: string;
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'));
}

/** Detect a "next page" absolute URL in a response body.
 *  Handles: direct fields, HAL _links.next, meta.next. */
export function detectNextPageUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;

  // Direct fields
  for (const key of ['next', 'next_url', 'nextUrl', 'nextPageUrl', 'next_page_url']) {
    const val = obj[key];
    if (isHttpUrl(val)) return val;
  }

  // HAL-style: _links.next or links.next (string or { href })
  for (const linksKey of ['_links', 'links']) {
    const links = obj[linksKey];
    if (links && typeof links === 'object' && !Array.isArray(links)) {
      const next = (links as Record<string, unknown>)['next'];
      if (isHttpUrl(next)) return next;
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        const href = (next as Record<string, unknown>)['href'];
        if (isHttpUrl(href)) return href;
      }
    }
  }

  // meta.next*
  const meta = obj['meta'];
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    for (const key of ['next', 'next_url', 'next_page_url']) {
      const val = m[key];
      if (isHttpUrl(val)) return val;
    }
  }

  return null;
}

/** Detect a cursor / page-token in a response body.
 *  Returns the query param name to use + the token value. */
export function detectNextCursor(body: unknown): NextCursor | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;

  const cursorKeys: [string, string][] = [
    ['next_page_token', 'page_token'],
    ['nextPageToken',   'pageToken'],
    ['next_cursor',     'cursor'],
    ['nextCursor',      'cursor'],
    ['continuation_token', 'continuation_token'],
  ];

  const searchIn = (target: Record<string, unknown>): NextCursor | null => {
    for (const [respKey, queryParam] of cursorKeys) {
      const val = target[respKey];
      if (typeof val === 'string' && val) return { queryParam, value: val };
    }
    return null;
  };

  return searchIn(obj) ?? (
    (() => {
      const meta = obj['meta'];
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return searchIn(meta as Record<string, unknown>);
      }
      return null;
    })()
  );
}

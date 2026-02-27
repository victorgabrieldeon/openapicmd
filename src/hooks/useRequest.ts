import { useState, useCallback } from 'react';
import { executeRequest, type RequestValues } from '../lib/executor.js';
import type { Endpoint, RequestResult } from '../types/openapi.js';
import type { Environment } from '../types/config.js';
import { addToHistory } from '../lib/history.js';

export type RequestState = 'idle' | 'loading' | 'success' | 'error';

export function useRequest() {
  const [state, setState] = useState<RequestState>('idle');
  const [result, setResult] = useState<RequestResult | null>(null);

  const execute = useCallback(
    async (endpoint: Endpoint, values: RequestValues, env: Environment | null, fallbackBaseUrl = '') => {
      setState('loading');
      setResult(null);
      try {
        const res = await executeRequest(endpoint, values, env, fallbackBaseUrl);
        setResult(res);
        setState(res.error ? 'error' : 'success');
        addToHistory(endpoint.id, endpoint.method, endpoint.path, env?.name ?? null, values, {
          status: res.status,
          statusText: res.statusText,
          durationMs: res.durationMs,
          error: res.error,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setResult({ status: 0, statusText: 'Error', headers: {}, body: null, durationMs: 0, error: msg });
        setState('error');
      }
    },
    []
  );

  const reset = useCallback(() => {
    setState('idle');
    setResult(null);
  }, []);

  return { state, result, execute, reset };
}

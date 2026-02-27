import { useEffect, useRef } from 'react';
import { parseSpec } from '../lib/parser.js';
import { addRecentSpec } from '../lib/config-store.js';
import { useApp } from '../context/AppContext.js';

export function useSpec(source: string | null) {
  const { dispatch } = useApp();
  const prevSourceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!source) return;
    // Only re-run when source actually changes
    if (source === prevSourceRef.current) return;
    prevSourceRef.current = source;

    dispatch({ type: 'SET_SPEC_LOADING', source });

    parseSpec(source)
      .then((spec) => {
        dispatch({ type: 'SET_SPEC', spec });
        addRecentSpec(source);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'SET_SPEC_ERROR', error: msg });
      });
  }); // No dependency array — runs after every render, but ref prevents re-parsing same source
}

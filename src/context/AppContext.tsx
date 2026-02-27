import React, { createContext, useContext, useReducer, type Dispatch } from 'react';
import type { Endpoint, ParsedSpec, TagGroup } from '../types/openapi.js';
import type { Environment } from '../types/config.js';

export type ActivePanel = 'sidebar' | 'detail' | 'request' | 'modal';
export type ModalType = 'load-spec' | 'env-manager' | 'token-provider' | null;

export interface AppState {
  specSource: string | null;
  spec: ParsedSpec | null;
  specLoading: boolean;
  specError: string | null;
  selectedEndpointId: string | null;
  activePanel: ActivePanel;
  activeModal: ModalType;
  tagGroups: TagGroup[];
  sidebarIndex: number;    // flat index across all visible items
  sidebarSearchActive: boolean; // true when sidebar search TextInput has focus
  environments: Environment[];
  activeEnvName: string | null;
}

export type AppAction =
  | { type: 'SET_SPEC_LOADING'; source: string }
  | { type: 'SET_SPEC'; spec: ParsedSpec }
  | { type: 'SET_SPEC_ERROR'; error: string }
  | { type: 'SELECT_ENDPOINT'; id: string }
  | { type: 'SET_ACTIVE_PANEL'; panel: ActivePanel }
  | { type: 'OPEN_MODAL'; modal: ModalType }
  | { type: 'CLOSE_MODAL' }
  | { type: 'CLOSE_MODAL_NAVIGATE'; panel: ActivePanel }
  | { type: 'TOGGLE_TAG'; tagName: string }
  | { type: 'SET_SIDEBAR_INDEX'; index: number }
  | { type: 'SET_ENVIRONMENTS'; environments: Environment[] }
  | { type: 'SET_ACTIVE_ENV'; name: string | null }
  | { type: 'LOAD_SPEC'; source: string }
  | { type: 'SET_SIDEBAR_SEARCH'; active: boolean };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SPEC_LOADING':
      return { ...state, specLoading: true, specError: null, spec: null, specSource: action.source, sidebarIndex: 0, selectedEndpointId: null };

    case 'SET_SPEC': {
      const tagGroups = action.spec.tagGroups;
      const firstEndpoint = tagGroups[0]?.endpoints[0]?.id ?? null;
      return {
        ...state,
        specLoading: false,
        spec: action.spec,
        tagGroups,
        selectedEndpointId: firstEndpoint,
        sidebarIndex: 0,
      };
    }

    case 'SET_SPEC_ERROR':
      return { ...state, specLoading: false, specError: action.error };

    case 'SELECT_ENDPOINT':
      return { ...state, selectedEndpointId: action.id };

    case 'SET_ACTIVE_PANEL':
      return { ...state, activePanel: action.panel };

    case 'OPEN_MODAL':
      return { ...state, activeModal: action.modal, activePanel: 'modal' };

    case 'CLOSE_MODAL':
      return { ...state, activeModal: null, activePanel: 'sidebar' };

    case 'CLOSE_MODAL_NAVIGATE':
      return { ...state, activeModal: null, activePanel: action.panel };

    case 'TOGGLE_TAG': {
      const tagGroups = state.tagGroups.map((g) =>
        g.name === action.tagName ? { ...g, isExpanded: !g.isExpanded } : g
      );
      return { ...state, tagGroups };
    }

    case 'SET_SIDEBAR_INDEX':
      return { ...state, sidebarIndex: action.index };

    case 'SET_ENVIRONMENTS':
      return { ...state, environments: action.environments };

    case 'SET_ACTIVE_ENV':
      return { ...state, activeEnvName: action.name };

    case 'LOAD_SPEC':
      // Just update the source; useSpec hook will detect the change and parse
      return { ...state, specSource: action.source };

    case 'SET_SIDEBAR_SEARCH':
      return { ...state, sidebarSearchActive: action.active };

    default:
      return state;
  }
}

const initialState: AppState = {
  specSource: null,
  spec: null,
  specLoading: false,
  specError: null,
  selectedEndpointId: null,
  activePanel: 'sidebar',
  activeModal: null,
  tagGroups: [],
  sidebarIndex: 0,
  sidebarSearchActive: false,
  environments: [],
  activeEnvName: null,
};

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  children,
  initialSource,
  initialEnvironments,
  initialActiveEnv,
}: {
  children: React.ReactNode;
  initialSource?: string;
  initialEnvironments?: Environment[];
  initialActiveEnv?: string | null;
}) {
  const [state, dispatch] = useReducer(appReducer, {
    ...initialState,
    specSource: initialSource ?? null,
    environments: initialEnvironments ?? [],
    activeEnvName: initialActiveEnv ?? null,
  });

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function useSelectedEndpoint(): Endpoint | null {
  const { state } = useApp();
  if (!state.selectedEndpointId || !state.spec) return null;
  return state.spec.endpoints.find((e) => e.id === state.selectedEndpointId) ?? null;
}

export function useActiveEnvironment(): Environment | null {
  const { state } = useApp();
  if (!state.activeEnvName) return null;
  return state.environments.find((e) => e.name === state.activeEnvName) ?? null;
}

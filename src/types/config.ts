export interface TokenProvider {
  /** display reference — "post:/auth/login" */
  endpointId: string;
  method: string;
  path: string;
  /** JSON body sent to the auth endpoint */
  body: string;
  /** Extra headers for the auth call only */
  extraHeaders: Record<string, string>;
  /** Dot-notation path to extract the token, e.g. "data.access_token" */
  tokenPath: string;
  /** Header to inject the token into, default "Authorization" */
  headerName: string;
  /** Prefix before the token value, default "Bearer " */
  prefix: string;
}

export interface Environment {
  name: string;
  /** Base URL used for all HTTP requests, e.g. https://api.example.com */
  baseUrl: string;
  /** Optional URL (or path) to load the OpenAPI spec from — can differ from baseUrl */
  specUrl?: string;
  headers: Record<string, string>;
  variables: Record<string, string>;
  /** Shell command run before each request. stdout must be JSON: {"headers": {...}} */
  preRequestHook?: string;
  /** Endpoint-based token provider configuration */
  tokenProvider?: TokenProvider;
}

export interface AppConfig {
  environments: Environment[];
  activeEnvironment: string | null;
  recentSpecs: string[];
}

export const DEFAULT_CONFIG: AppConfig = {
  environments: [],
  activeEnvironment: null,
  recentSpecs: [],
};

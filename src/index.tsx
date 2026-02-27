#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './components/App.js';
import { AppProvider } from './context/AppContext.js';
import { getConfig, getActiveEnvironment } from './lib/config-store.js';

const cli = meow(
  `
  Usage
    $ openapicmd-tui [spec]

  Arguments
    spec   Path to OpenAPI spec file or URL (optional)

  Examples
    $ openapicmd-tui ./petstore.yaml
    $ openapicmd-tui https://petstore.swagger.io/v2/swagger.json
`,
  {
    importMeta: import.meta,
    flags: {},
  }
);

const source = cli.input[0] ?? null;
const config = getConfig();
const activeEnv = getActiveEnvironment();

const { waitUntilExit } = render(
  <AppProvider
    initialSource={source ?? undefined}
    initialEnvironments={config.environments}
    initialActiveEnv={activeEnv?.name ?? null}
  >
    <App />
  </AppProvider>
);

await waitUntilExit();

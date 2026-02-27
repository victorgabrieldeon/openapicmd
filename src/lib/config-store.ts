import Conf from 'conf';
import type { AppConfig, Environment } from '../types/config.js';
import { DEFAULT_CONFIG } from '../types/config.js';

const store = new Conf<AppConfig>({
  projectName: 'openapicmd-tui',
  defaults: DEFAULT_CONFIG,
});

export function getConfig(): AppConfig {
  return {
    environments: store.get('environments'),
    activeEnvironment: store.get('activeEnvironment'),
    recentSpecs: store.get('recentSpecs'),
  };
}

export function saveEnvironment(env: Environment): void {
  const envs = store.get('environments');
  const idx = envs.findIndex((e) => e.name === env.name);
  if (idx >= 0) {
    envs[idx] = env;
  } else {
    envs.push(env);
  }
  store.set('environments', envs);
}

export function deleteEnvironment(name: string): void {
  const envs = store.get('environments').filter((e) => e.name !== name);
  store.set('environments', envs);
  if (store.get('activeEnvironment') === name) {
    store.set('activeEnvironment', null);
  }
}

export function setActiveEnvironment(name: string | null): void {
  store.set('activeEnvironment', name);
}

export function addRecentSpec(source: string): void {
  const recents = store.get('recentSpecs');
  const filtered = recents.filter((s) => s !== source);
  store.set('recentSpecs', [source, ...filtered].slice(0, 10));
}

export function getActiveEnvironment(): Environment | null {
  const name = store.get('activeEnvironment');
  if (!name) return null;
  return store.get('environments').find((e) => e.name === name) ?? null;
}

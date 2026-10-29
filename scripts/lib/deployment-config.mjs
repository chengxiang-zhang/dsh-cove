// Deployment configuration: templates live in the repository, machine values do not.
//
// Resolution order:
//   1. $DSH_COVE_CONFIG (an explicit file path)
//   2. config/deployment.local.json (gitignored; the machine's real values)
//   3. config/deployment.example.json (committed placeholders)
//
// A missing or malformed value is an error for code that needs it; building or testing a
// checkout without local values is not. Callers that must not ship placeholder values check
// `configSource`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATHS = {
  local: join(repoRoot, 'config', 'deployment.local.json'),
  template: join(repoRoot, 'config', 'deployment.example.json'),
};

function readConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`deployment config: cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`deployment config: ${path} is not valid JSON: ${error.message}`);
  }
}

function pickPath() {
  const explicit = process.env.DSH_COVE_CONFIG;
  if (explicit) {
    return { path: resolve(explicit), source: 'env' };
  }
  if (existsSync(CONFIG_PATHS.local)) {
    return { path: CONFIG_PATHS.local, source: 'local' };
  }
  return { path: CONFIG_PATHS.template, source: 'template' };
}

/**
 * @param {string} [path]
 * @returns {{ values: any, path: string, source: 'env'|'local'|'template' }}
 */
export function loadDeploymentConfig(path) {
  const chosen = path ? { path: resolve(path), source: 'env' } : pickPath();
  if (!existsSync(chosen.path)) {
    throw new Error(`deployment config: ${chosen.path} does not exist`);
  }
  return { values: readConfigFile(chosen.path), path: chosen.path, source: chosen.source };
}

/**
 * Resolve one dotted key, failing loudly when it is missing, empty, or not a string.
 *
 * @param {string} dotted
 * @param {{ values: any, path: string }} config
 * @returns {string}
 */
export function requireString(dotted, config) {
  const parts = dotted.split('.');
  let cursor = config.values;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || !(part in cursor)) {
      throw new Error(`deployment config: ${config.path} has no ${dotted}`);
    }
    cursor = cursor[part];
  }
  if (typeof cursor !== 'string' || cursor.trim() === '') {
    throw new Error(`deployment config: ${config.path} has an empty or non-string ${dotted}`);
  }
  return cursor;
}

/** Replace `{{dotted.key}}` placeholders in a template body. */
export function renderTemplate(body, config, sourceName = 'template') {
  return body.replace(/\{\{([a-z0-9.]+)\}\}/giu, (match, dotted) => {
    try {
      return requireString(dotted, config);
    } catch (error) {
      throw new Error(`template ${sourceName}: ${error.message}`);
    }
  });
}

export { repoRoot };

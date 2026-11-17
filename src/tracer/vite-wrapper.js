import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDirname } from '../utils/paths.js';

/**
 * Zero-config tracing: when the project's vite config does not register
 * `ada-scan/vite`, the instrumented build runs `vite build --config <wrapper>`
 * where the wrapper (a temporary file under `<root>/.ada-scan/tmp`, removed
 * afterwards) imports the project config and appends the instrumentation plugin.
 * The project is never modified.
 */

const PLUGIN_FILE = path.resolve(getDirname(import.meta.url), '../../vite/scan-instrumentation.js');
export const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
const DEFAULT_COMMAND = 'pnpm build:vite';
const REGISTERED = /scan-instrumentation|scanInstrumentationPlugin|ada-scan\/vite/;

export function findViteConfig(root) {
  return VITE_CONFIG_NAMES.map((n) => path.join(root, n)).find((p) => existsSync(p)) || null;
}

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/** Script body behind `pnpm build:vite` / `npm run x` / `yarn x`; null when the command is not a package script. */
function scriptBody(root, buildCommand) {
  const [pm, ...args] = String(buildCommand).trim().split(/\s+/);
  if (!['pnpm', 'npm', 'yarn'].includes(pm)) return { custom: true };
  const name = args[0] === 'run' ? args[1] : args[0];
  let scripts = {};
  try { scripts = JSON.parse(readText(path.join(root, 'package.json')) || '{}').scripts || {}; } catch { /* unreadable */ }
  return { name, body: scripts[name] ?? null };
}

/**
 * Decides how the instrumented build runs.
 *  - native: the project config already registers the plugin; run `buildCommand` as is.
 *  - wrapped: run local vite with a temporary wrapper config (`cmd`/`args`, `configFile`).
 *  - unavailable: tracing cannot be set up automatically; `reason` + `remedy` say why and how to fix.
 */
export function planTracingBuild(root, config = {}) {
  const buildCommand = config.buildCommand || DEFAULT_COMMAND;
  if (config.autoInstrument === false) return { mode: 'native', buildCommand };
  const script = scriptBody(root, buildCommand);
  if (script.custom) return { mode: 'native', buildCommand };
  const unavailable = (reason, remedy) => ({ mode: 'unavailable', buildCommand, reason, remedy });
  if (script.body == null) return { mode: 'native', buildCommand }; // missing script: the build itself reports it
  const m = /^vite\s+build((?:\s+\S+)*)\s*$/.exec(script.body.trim());
  if (!m) {
    return unavailable(
      `script "${script.name}" is "${script.body}", not a plain "vite build"; cannot add the instrumentation plugin automatically`,
      'Register scanInstrumentationPlugin() from "ada-scan/vite" in the vite config, or set buildCommand to a plain "vite build" script',
    );
  }
  const args = m[1].trim() ? m[1].trim().split(/\s+/) : [];
  let rel = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') { rel = args[i + 1]; args.splice(i, 2); i--; } else if (/^--config=/.test(args[i])) { rel = args[i].slice(9); args.splice(i, 1); i--; }
  }
  const configFile = rel ? path.resolve(root, rel) : findViteConfig(root);
  if (!configFile || !existsSync(configFile)) {
    return unavailable(`no vite config found in ${root}`, `Add vite.config.(ts|js|mjs) or register scanInstrumentationPlugin() from "ada-scan/vite"`);
  }
  const text = readText(configFile);
  if (text != null && REGISTERED.test(text)) return { mode: 'native', buildCommand, configFile };
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    return unavailable(`local vite binary not found at ${path.relative(root, viteBin)}`, 'Install the project dependencies (vite) before scanning');
  }
  return { mode: 'wrapped', buildCommand, configFile, cmd: process.execPath, args: [viteBin, 'build', ...args] };
}

/** Wrapper source: the project config (object, function, async, promise) plus the plugin, appended once. */
export function wrapperSource(configFile) {
  return `import * as userModule from ${JSON.stringify(configFile.replace(/\\/g, '/'))};
const pluginUrl = ${JSON.stringify(pathToFileURL(PLUGIN_FILE).href)};
const names = async (list) => {
  const out = [];
  for (const p of list || []) {
    const v = await p;
    if (Array.isArray(v)) out.push(...await names(v)); else if (v && v.name) out.push(v.name);
  }
  return out;
};
export default async function (env) {
  let cfg = userModule.default ?? userModule;
  cfg = (typeof cfg === 'function' ? await cfg(env) : await cfg) ?? {};
  if ((await names(cfg.plugins)).includes('scan-instrumentation')) return cfg;
  const { scanInstrumentationPlugin } = await import(/* @vite-ignore */ pluginUrl);
  return { ...cfg, plugins: [...(cfg.plugins || []), scanInstrumentationPlugin()] };
}
`;
}

/** Writes the wrapper under <root>/.ada-scan/tmp; `cleanup()` removes it. */
export function writeWrapperConfig(root, configFile) {
  const base = path.join(root, '.ada-scan', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'vite-'));
  const file = path.join(dir, 'vite.config.scan.mjs');
  writeFileSync(file, wrapperSource(configFile));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

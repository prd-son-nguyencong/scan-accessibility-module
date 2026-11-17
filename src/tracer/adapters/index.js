import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../utils/config.js';
import { resolveProject } from '../../utils/project.js';
import { getAdapter } from './registry.js';
import './paradox-liquid.js'; // registers the adapter even when nothing else imported trace-element
import './html.js';
import './react.js';

export { getAdapter, listAdapters, registerAdapter } from './registry.js';

// Frameworks recognised on purpose but not traced yet: they get a clear message instead of a guess.
const DEFERRED = [
  { name: 'nuxt', deps: ['nuxt', 'nuxt3'], config: /^nuxt\.config\./ },
  { name: 'stencil', deps: ['@stencil/core'], config: /^stencil\.config\./ },
  { name: 'vue', deps: ['vue'], config: /^vue\.config\./ },
];

function readDeps(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  } catch {
    return new Set();
  }
}

const listDir = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/**
 * Project-relative `.liquid` files under the default roots plus the configured source.roots,
 * pagesRoot and its parent dir (custom-layout projects), de-duplicated.
 */
export function liquidFiles(root) {
  const cfg = existsSync(path.join(root, '.scan-config.json')) ? loadConfig(root) : {};
  const { pagesRoot } = resolveProject(cfg, root);
  const roots = new Set([...LIQUID_ROOTS, ...(cfg.source?.roots || []), pagesRoot, path.posix.dirname(pagesRoot)]);
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return []; }
    return entries.flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : e.name.endsWith('.liquid') ? [`${rel}/${e.name}`] : []));
  };
  return [...new Set([...roots].filter((r) => r !== '.').flatMap(walk))];
}

export const LIQUID_ROOTS = ['src/pages', 'src/layouts', 'src/partials', 'src/components'];

/**
 * Framework of a project root from package.json deps and *.config.* files.
 * @returns {{ id: 'paradox-liquid'|'next'|'react'|'html'|'unsupported-deferred'|'unknown', framework?: string, message?: string }}
 *   `unsupported-deferred` carries the detected `framework` name and a message; adapters for
 *   next/react/html are separate tasks, so those ids can be detected without a registered adapter.
 */
export function detectFramework(root) {
  const deps = readDeps(root);
  const configs = listDir(root);
  const has = (...names) => names.some((n) => deps.has(n));
  const deferred = DEFERRED.find((d) => has(...d.deps) || configs.some((f) => d.config.test(f)));
  if (deferred) {
    return { id: 'unsupported-deferred', framework: deferred.name, message: `${deferred.name} detected: its source adapter is deferred, so findings stay untraceable` };
  }
  if (has('next') || configs.some((f) => /^next\.config\./.test(f))) return { id: 'next' };
  if (has('liquidjs') || liquidFiles(root).length > 0) return { id: 'paradox-liquid' };
  if (has('react', 'react-dom')) return { id: 'react' };
  if (configs.some((f) => f.endsWith('.html')) || ['src', 'public'].some((d) => listDir(path.join(root, d)).some((f) => f.endsWith('.html')))) {
    return { id: 'html' };
  }
  return { id: 'unknown', message: 'no supported framework detected (no Paradox Liquid, Next, React or plain HTML project)' };
}

/** `override` (explicit) beats `tracer.adapter` in .scan-config.json; 'auto' or nothing means detect. */
function configuredAdapter(root, override) {
  if (override) return override;
  return existsSync(path.join(root, '.scan-config.json')) ? loadConfig(root).tracer?.adapter : undefined;
}

/**
 * The adapter that should trace this root, or why none can.
 * @returns {{ id: string, adapter: object|null, reason: 'unknown-framework'|'unsupported-framework'|null, message?: string }}
 */
export function resolveAdapter(root, override) {
  const wanted = configuredAdapter(root, override);
  const detected = wanted && wanted !== 'auto' ? { id: wanted } : detectFramework(root);
  const adapter = getAdapter(detected.id);
  if (adapter) return { id: detected.id, adapter, reason: null };
  const reason = detected.id === 'unknown' ? 'unknown-framework' : 'unsupported-framework';
  const message = detected.message || `no source adapter for "${detected.id}" yet`;
  return { id: detected.id, adapter: null, reason, message };
}

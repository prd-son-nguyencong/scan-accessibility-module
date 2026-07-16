import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRuleDescriptor } from './schema.js';

/**
 * @typedef {object} EvaluatorResult
 * @property {'complete' | 'inapplicable'} status
 * @property {number} candidates
 * @property {number=} candidatesScanned
 * @property {Array<Record<string, unknown>>=} findings
 *
 * @typedef {object} EvaluatorModule
 * @property {string} id
 * @property {(context: unknown, check: unknown, options?: { signal?: AbortSignal }) => Promise<EvaluatorResult>} evaluate
 */

/**
 * Deterministic sorted filesystem traversal for module discovery.
 *
 * @param {string} rootDir
 * @param {string} suffix
 * @returns {Promise<string[]>}
 */
export async function discoverModulePaths(rootDir, suffix) {
  /** @type {string[]} */
  const paths = [];

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir).sort()) {
      const fullPath = path.join(currentDir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.endsWith(suffix)) {
        paths.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return paths.sort();
}

/**
 * @param {unknown} moduleExport
 * @returns {import('./schema.js').RuleDescriptor[]}
 */
function flattenDescriptorExport(moduleExport) {
  if (Array.isArray(moduleExport)) {
    return moduleExport.flatMap((entry) => flattenDescriptorExport(entry));
  }
  return [/** @type {import('./schema.js').RuleDescriptor} */ (moduleExport)];
}

/**
 * @param {import('./schema.js').RuleDescriptor[]} descriptors
 * @param {string=} sourceLabel
 * @returns {import('./schema.js').RuleDescriptor[]}
 */
function validateDescriptorBatch(descriptors, sourceLabel = 'descriptor pack') {
  for (const descriptor of descriptors) {
    const validation = validateRuleDescriptor(descriptor);
    if (!validation.valid) {
      const details = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
      throw new Error(`Invalid rule descriptor in ${sourceLabel}: ${details}`);
    }
  }
  return descriptors;
}

/**
 * Load rule descriptors from a directory, inline pack array, or mixed packs.
 *
 * @param {string | import('./schema.js').RuleDescriptor[] | import('./schema.js').RuleDescriptor[][]} input
 * @returns {Promise<import('./schema.js').RuleDescriptor[]>}
 */
export async function loadRuleDescriptors(input) {
  if (Array.isArray(input)) {
    const descriptors = input.flatMap((entry) => flattenDescriptorExport(entry));
    return validateDescriptorBatch(descriptors, 'descriptor pack array');
  }

  const paths = await discoverModulePaths(input, '.rules.js');
  /** @type {import('./schema.js').RuleDescriptor[]} */
  const descriptors = [];

  for (const filePath of paths) {
    const module = await import(pathToFileURL(filePath).href);
    descriptors.push(...flattenDescriptorExport(module.default));
  }

  return validateDescriptorBatch(descriptors);
}

/**
 * @param {string} evaluatorsDir
 * @returns {Promise<Map<string, EvaluatorModule>>}
 */
export async function loadEvaluators(evaluatorsDir) {
  const paths = await discoverModulePaths(evaluatorsDir, '.evaluator.js');
  /** @type {Map<string, EvaluatorModule>} */
  const evaluators = new Map();

  for (const filePath of paths) {
    const module = await import(pathToFileURL(filePath).href);
    const evaluator = module.default;
    if (!evaluator?.id || typeof evaluator.evaluate !== 'function') {
      throw new Error(`Invalid evaluator module in ${filePath}`);
    }
    if (evaluators.has(evaluator.id)) {
      throw new Error(`Duplicate evaluator id "${evaluator.id}" in ${filePath}`);
    }
    evaluators.set(evaluator.id, evaluator);
  }

  return evaluators;
}

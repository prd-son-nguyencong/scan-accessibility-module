/**
 * @typedef {{ path: string, message: string }} ValidationError
 */

const ID_SELECTOR = /#[A-Za-z][\w-]*/;
const CLASS_SELECTOR = /\.[A-Za-z][\w-]*/;
const DATA_TESTID_SELECTOR = /\[data-testid/i;
const NTH_SELECTOR = /:nth-(?:child|of-type)\(/i;
const URL_LITERAL = /https?:\/\//i;
const HOSTNAME_LITERAL = /\b(?:www\.|[a-z0-9][-a-z0-9]*\.(?:com|org|net|io|dev|test|local))\b/i;

const FIXED_COUNT_OPTION_KEYS = new Set([
  'expectedCount',
  'expectedFailureCount',
  'expectedSuccessCount',
  'expectedFailures',
  'expectedSuccesses',
  'failureCount',
  'successCount',
  'minExpected',
  'maxExpected',
]);

/**
 * @param {string} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validatePortableString(value, path, errors) {
  if (ID_SELECTOR.test(value)) {
    errors.push({ path, message: 'must not use ID selectors' });
  }
  if (CLASS_SELECTOR.test(value)) {
    errors.push({ path, message: 'must not use class selectors' });
  }
  if (DATA_TESTID_SELECTOR.test(value)) {
    errors.push({ path, message: 'must not use data-testid selectors' });
  }
  if (NTH_SELECTOR.test(value)) {
    errors.push({ path, message: 'must not use nth-child or nth-of-type selectors' });
  }
  if (URL_LITERAL.test(value)) {
    errors.push({ path, message: 'must not include URL literals' });
  }
  if (HOSTNAME_LITERAL.test(value)) {
    errors.push({ path, message: 'must not include hostname literals' });
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function walkPortableValue(value, path, errors) {
  if (typeof value === 'string') {
    validatePortableString(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkPortableValue(item, `${path}/${index}`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      if (FIXED_COUNT_OPTION_KEYS.has(key)) {
        errors.push({ path: childPath, message: 'fixed expected count options are not portable' });
      }
      walkPortableValue(child, childPath, errors);
    }
  }
}

/**
 * @param {import('./schema.js').RuleCheckDescriptor} check
 * @param {number} checkIndex
 * @returns {ValidationError[]}
 */
export function validateCheckPortability(check, checkIndex) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (check.target) {
    walkPortableValue(check.target, `/checks/${checkIndex}/target`, errors);
  }
  if (check.options) {
    walkPortableValue(check.options, `/checks/${checkIndex}/options`, errors);
  }
  if (check.eligibility) {
    walkPortableValue(check.eligibility, `/checks/${checkIndex}/eligibility`, errors);
  }
  return errors;
}

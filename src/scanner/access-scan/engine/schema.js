import { validateCheckPortability } from './portability.js';
import { validateCheckClassification } from './classification.js';
import { validateCheckTarget } from './target-validation.js';

/**
 * @typedef {'active' | 'legacy-readable'} RuleStatus
 * @typedef {'deterministic' | 'heuristic' | 'behavioral' | 'manual'} AutomationKind
 * @typedef {'standards' | 'commercial-parity'} ProfileId
 * @typedef {'confirmed' | 'potential' | 'commercial-parity' | 'manual-review'} ViolationType
 *
 * @typedef {object} RuleCheckDescriptor
 * @property {string} id
 * @property {ProfileId[]} profiles
 * @property {string} evaluator
 * @property {{ selector?: string, roots?: string[] }=} target
 * @property {Record<string, unknown>=} eligibility
 * @property {Record<string, unknown>=} options
 * @property {ViolationType=} classification
 *
 * @typedef {object} RuleDescriptor
 * @property {string} id
 * @property {RuleStatus} status
 * @property {string} category
 * @property {string=} publicCategory
 * @property {string[]=} aliases
 * @property {{ version: string, level: string, criterion: string }} standard
 * @property {{ impact: string, priority: number }} severity
 * @property {AutomationKind} automation
 * @property {RuleCheckDescriptor[]} checks
 * @property {{ title: string, requirement: string, recommendation: string }} reporting
 * @property {{ deterministic: boolean, policy: string }} fix
 */

/** @type {import('./schema.js').RuleDescriptor extends never ? never : object} */
export const RULE_DESCRIPTOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'status',
    'category',
    'standard',
    'severity',
    'automation',
    'checks',
    'reporting',
    'fix',
  ],
  properties: {
    id: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]+$' },
    status: { type: 'string', enum: ['active', 'legacy-readable'] },
    category: { type: 'string', minLength: 1 },
    publicCategory: {
      type: 'string',
      enum: [
        'general',
        'interactive',
        'forms',
        'landmarks',
        'graphics',
        'dragging',
        'aria',
        'lists',
        'metadata',
        'tabs',
        'tables',
      ],
    },
    aliases: { type: 'array', items: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]+$' } },
    standard: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'level', 'criterion'],
      properties: {
        version: { type: 'string', minLength: 1 },
        level: { type: 'string', minLength: 1 },
        criterion: { type: 'string', minLength: 1 },
      },
    },
    severity: {
      type: 'object',
      additionalProperties: false,
      required: ['impact', 'priority'],
      properties: {
        impact: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor'] },
        priority: { type: 'integer', minimum: 1, maximum: 6 },
      },
    },
    automation: {
      type: 'string',
      enum: ['deterministic', 'heuristic', 'behavioral', 'manual'],
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'profiles', 'evaluator'],
        properties: {
          id: { type: 'string', minLength: 1 },
          profiles: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: ['standards', 'commercial-parity'] },
          },
          evaluator: { type: 'string', minLength: 1 },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              selector: { type: 'string' },
              roots: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['document', 'shadow', 'frame', 'all'],
                },
              },
              allowPluginFallback: { type: 'boolean' },
            },
          },
          eligibility: {
            type: 'object',
            additionalProperties: false,
            properties: {
              visibility: {
                type: 'string',
                enum: ['active-content', 'visibility', 'all'],
              },
            },
          },
          options: { type: 'object' },
          classification: {
            type: 'string',
            enum: ['confirmed', 'potential', 'commercial-parity', 'manual-review'],
          },
        },
      },
    },
    reporting: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'requirement', 'recommendation'],
      properties: {
        title: { type: 'string', minLength: 1 },
        requirement: { type: 'string', minLength: 1 },
        recommendation: { type: 'string', minLength: 1 },
      },
    },
    fix: {
      type: 'object',
      additionalProperties: false,
      required: ['deterministic', 'policy'],
      properties: {
        deterministic: { type: 'boolean' },
        policy: { type: 'string', minLength: 1 },
      },
    },
  },
});

/**
 * @typedef {{ path: string, message: string }} ValidationError
 * @typedef {{ valid: true, errors: [] } | { valid: false, errors: ValidationError[] }} ValidationResult
 */

/**
 * @param {unknown} value
 * @param {object} schema
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateValue(value, schema, path, errors) {
  const type = schema.type;

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ path, message: 'must be an object' });
      return;
    }
    for (const key of schema.required || []) {
      if (!(key in /** @type {Record<string, unknown>} */ (value))) {
        errors.push({ path: `${path}/${key}`, message: 'is required' });
      }
    }
    const declaredKeys = new Set(Object.keys(schema.properties || {}));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
        if (!declaredKeys.has(key)) {
          errors.push({ path: `${path}/${key}`, message: 'is an unknown property' });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        if (!declaredKeys.has(key)) {
          validateValue(child, schema.additionalProperties, `${path}/${key}`, errors);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in /** @type {Record<string, unknown>} */ (value)) {
        validateValue(
          /** @type {Record<string, unknown>} */ (value)[key],
          childSchema,
          `${path}/${key}`,
          errors,
        );
      }
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, message: 'must be an array' });
      return;
    }
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateValue(item, schema.items, `${path}/${index}`, errors);
      });
    }
    return;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ path, message: 'must be a string' });
      return;
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} character(s)` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `must match pattern ${schema.pattern}` });
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({ path, message: `must be one of: ${schema.enum.join(', ')}` });
    }
    return;
  }

  if (type === 'integer') {
    if (!Number.isInteger(value)) {
      errors.push({ path, message: 'must be an integer' });
      return;
    }
    if (schema.minimum != null && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
    return;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({ path, message: 'must be a boolean' });
    }
  }
}

/**
 * @param {import('./schema.js').RuleDescriptor} descriptor
 * @returns {ValidationError[]}
 */
function validateLegacyReadableRule(descriptor) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (descriptor.status !== 'legacy-readable') {
    return errors;
  }
  if (descriptor.checks.length > 0) {
    errors.push({
      path: '/checks',
      message: 'legacy-readable rules must have empty checks',
    });
  }
  if (descriptor.automation !== 'manual') {
    errors.push({
      path: '/automation',
      message: 'legacy-readable rules must use manual automation metadata',
    });
  }
  return errors;
}

/**
 * @param {unknown} descriptor
 * @returns {ValidationResult}
 */
export function validateRuleDescriptor(descriptor) {
  /** @type {ValidationError[]} */
  const errors = [];
  validateValue(descriptor, RULE_DESCRIPTOR_SCHEMA, '', errors);
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const rule = /** @type {import('./schema.js').RuleDescriptor} */ (descriptor);
  errors.push(...validateLegacyReadableRule(rule));
  if (rule.automation !== 'deterministic' && rule.fix.deterministic) {
    errors.push({
      path: '/fix/deterministic',
      message: 'non-deterministic automation cannot claim deterministic fix',
    });
  }

  rule.checks.forEach((check, index) => {
    errors.push(...validateCheckPortability(check, index));
    errors.push(...validateCheckClassification(rule, index));
    errors.push(...validateCheckTarget(check, index));
  });

  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

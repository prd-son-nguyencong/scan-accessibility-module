import { getIndexes } from '../evaluators/lib/runtime-context.js';
import { visibleTextIsInAccessibleName } from './lib/accessible-name.js';
import { factsByKind, findingFromFact, resolveSubject } from './lib/resolve.js';
import { qualifiesVisibilityMismatch } from './lib/visibility-standards.js';

/**
 * Standards policy maps generic DOM facts to standards-profile candidate findings.
 * It is independently callable and never imports commercial policy modules.
 *
 * @param {import('../signals/types.js').DomFact} fact
 * @param {unknown} context
 * @param {string=} mode
 * @returns {import('../engine/loader.js').EvaluatorResult['findings']}
 */
export function mapFactToStandardsFindings(fact, context, mode) {
  const indexes = getIndexes(context);
  /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
  const findings = [];

  if ((!mode || mode === 'label-in-name') && fact.kind === 'semantics.accessible-name') {
    const visibleText = String(fact.evidence.visibleText || '');
    const accessibleName = String(fact.evidence.accessibleName || '');
    if (!visibleTextIsInAccessibleName({ visibleText, accessibleName })) {
      const finding = findingFromFact(indexes, fact, { visibleText, accessibleName });
      if (finding) findings.push(finding);
    }
    return findings;
  }

  if ((!mode || mode === 'visibility-mismatch') && fact.kind === 'visibility.aria-hidden-exposed') {
    const element = resolveSubject(indexes, fact);
    const snapshot = /** @type {{ snapshot: import('../runtime/types.js').Snapshot }} */ (context).snapshot;
    if (element && qualifiesVisibilityMismatch(snapshot, indexes, element)) {
      const finding = findingFromFact(indexes, fact, {});
      if (finding) findings.push(finding);
    }
    return findings;
  }

  if ((!mode || mode === 'icon-discernible') && fact.kind === 'graphics.unlabeled-icon') {
    const finding = findingFromFact(indexes, fact, {});
    if (finding) findings.push(finding);
    return findings;
  }

  if ((!mode || mode === 'icon-discernible') && fact.kind === 'graphics.hidden-symbol') {
    const element = resolveSubject(indexes, fact);
    if (!element || !element.rendered) return findings;
    if (Number(fact.evidence.area) < 2000 && !fact.evidence.hasDisabledAncestor) return findings;
    const finding = findingFromFact(indexes, fact, {
      area: fact.evidence.area,
      hasSymbolReference: fact.evidence.hasSymbolReference,
    });
    if (finding) findings.push(finding);
    return findings;
  }

  return findings;
}

/**
 * @param {import('../signals/types.js').SignalBundle} bundle
 * @param {unknown} context
 * @param {{ mode?: string }=} options
 * @returns {import('../engine/loader.js').EvaluatorResult['findings']}
 */
export function applyStandardsPolicy(bundle, context, options = {}) {
  const mode = options.mode;
  const findings = bundle.facts.flatMap((fact) => mapFactToStandardsFindings(fact, context, mode));
  return findings;
}

/**
 * @param {string} mode
 * @param {import('../signals/types.js').SignalBundle} bundle
 * @param {unknown} context
 */
export function completeStandardsPolicy(mode, bundle, context) {
  const findings = applyStandardsPolicy(bundle, context, { mode });
  const metricKey = {
    'label-in-name': 'accessibleNameControlsScanned',
    'visibility-mismatch': 'ariaHiddenElementsScanned',
    'icon-discernible': 'graphicsElementsScanned',
  }[mode];
  return {
    status: 'complete',
    candidatesScanned: metricKey ? bundle.metrics[metricKey] : bundle.facts.length,
    findings,
  };
}

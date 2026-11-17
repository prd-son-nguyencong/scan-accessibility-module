import { MEASURED_PROOF_TYPES, proofFor, settleFinding } from '../../src/utils/verdict.js';

// One sample per way a deterministic row reaches the choke point: what its layer records, and what that proves. Shared by
// test/proof-families.test.js (a confirmed row always has a measured proof type) and docs/verdict-matrix.md (what each family may reach).
export const PROOF_FAMILIES = [
  { family: 'axe, per-node failure summary', v: { layer: 'axe', ruleId: 'duplicate-id-aria', evidence: { failureSummary: 'Fix any of the following:\n  Document has multiple elements with the same id attribute: "main"' } } },
  { family: 'axe, measured contrast', v: { layer: 'axe', ruleId: 'color-contrast', evidence: { pixelContrast: { min: 2.1 } } } },
  { family: 'axe, generic help only', v: { layer: 'axe', ruleId: 'image-alt', evidence: { help: 'Images must have alternative text' } } },
  { family: 'html-validate / w3c, message quotes the value', v: { layer: 'htmlValidate', ruleId: 'html-validate:no-dup-id', description: 'Duplicate ID "main"' } },
  { family: 'html-validate / w3c, rule wording only', v: { layer: 'htmlValidate', ruleId: 'html-validate:no-inline-style', description: 'Inline style is not allowed' } },
  { family: 'lighthouse, per-node explanation', v: { layer: 'lighthouse', ruleId: 'label-content-name-mismatch', evidence: { explanation: 'Fix any of the following:\n  Text inside the element is not included in the accessible name' } } },
  { family: 'lighthouse, rule id only', v: { layer: 'lighthouse', ruleId: 'label-content-name-mismatch', evidence: { audit: { title: 'Elements with visible text labels do not have matching accessible names.' } } } },
  { family: 'visible text vs accessible name captured', v: { layer: 'accessScan', ruleId: 'VisibleTextPartOfAccessibleName', evidence: { visibleText: 'Got it', accessibleName: 'dismiss' } } },
  { family: 'layer-recorded proof', v: { layer: 'links', ruleId: 'dead-link-404', evidence: { proof: { type: 'http-status', fact: 'HTTP 404' } } } },
  { family: 'accessScan, measured-fact holding a measured value', v: { layer: 'accessScan', ruleId: 'TargetSize', evidence: { proof: { type: 'measured-fact', fact: '<a class="x">: target is 12px by 12px' } } } },
  { family: 'accessScan, measured-fact that is only the rule rationale and the opening tag', v: { layer: 'accessScan', ruleId: 'PageTitleValid', evidence: { proof: { type: 'measured-fact', fact: '<title />: the title element is present and non-empty or not' } } } },
  { family: 'behavioural rule, instance description only (check recorded no proof)', v: { layer: 'screenReader', ruleId: 'html-missing-lang', description: 'html element has no lang attribute' } },
  { family: 'behavioural rule, proof recorded by the check', v: { layer: 'screenReader', ruleId: 'html-missing-lang', description: 'html element has no lang attribute', evidence: { proof: { type: 'attribute-value', fact: '<html lang="">: no language value' } } } },
  { family: 'behavioural rule, no instance text', v: { layer: 'screenReader', ruleId: 'html-missing-lang' } },
];

/** What a deterministic row of each family becomes at the choke point: { family, proofType, verdict }. */
export function evaluateProofFamilies() {
  return PROOF_FAMILIES.map(({ family, v }) => {
    const proof = proofFor(v);
    const { verdict } = settleFinding({ kind: 'deterministic', verdict: 'confirmed', impact: 'serious', ruleId: v.ruleId, proof });
    return { family, proofType: proof?.type ?? null, verdict };
  });
}

export const isMeasured = (type) => MEASURED_PROOF_TYPES.has(type);

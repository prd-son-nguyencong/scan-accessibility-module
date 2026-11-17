import { canonicalSha256 } from '../../../src/reporter/fingerprint.js';
import { normalizeCorpusRuleId } from '../../../src/reporter/rule-aliases.js';
import { sanitizeOracleSnippetHtml } from './oracle-snippet-sanitize.js';

/**
 * @param {Record<string, unknown>} oracleReport
 * @returns {string}
 */
export function buildOracleEvidenceDigest(oracleReport = {}) {
  const findings = Array.isArray(oracleReport.findings) ? oracleReport.findings : [];
  const normalized = findings.map((finding, index) => {
    const element = /** @type {{ outerHTML?: string, html?: string }} */ (finding.element || {});
    const html = sanitizeOracleSnippetHtml(String(element.outerHTML || element.html || ''));
    return {
      index,
      ruleId: normalizeCorpusRuleId(String(finding.ruleId || finding.canonicalRuleId || '')),
      html,
    };
  }).sort((left, right) => (
    `${left.ruleId}|${left.html}|${left.index}`.localeCompare(`${right.ruleId}|${right.html}|${right.index}`)
  ));

  return canonicalSha256({
    kind: 'oracle-evidence-digest',
    profile: oracleReport.profile || null,
    findings: normalized,
  });
}

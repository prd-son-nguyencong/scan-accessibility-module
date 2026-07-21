import { normalizeSourcePath } from '../../reporter/fingerprint.js';

function partialKey(partial) {
  return `${partial.file}|${partial.line}|${partial.preimageSha256 || ''}|${partial.method || ''}`;
}

function attestedPartialFromFinding(finding) {
  const source = finding.source || {};
  if (!source.file || !Number.isInteger(source.line) || source.line <= 0) {
    return null;
  }
  return {
    file: normalizeSourcePath(source.file),
    line: source.line,
    confidence: source.confidence || 'high',
    method: source.method || 'attested-source',
    preimageSha256: source.preimageSha256 || null,
  };
}

/**
 * Build trace inbox candidates from report-provided source attribution.
 */
export function buildTraceCandidatesFromFindings(findings = []) {
  return findings
    .map((finding) => {
      const partials = [];
      const attested = attestedPartialFromFinding(finding);
      if (attested) partials.push(attested);
      for (const partial of finding.traceCandidates || finding.sourceCandidates || []) {
        if (!partial?.file) continue;
        partials.push({
          file: normalizeSourcePath(partial.file),
          line: Number.isInteger(partial.line) && partial.line > 0 ? partial.line : null,
          confidence: partial.confidence || 'low',
          method: partial.method || 'candidate',
          preimageSha256: partial.preimageSha256 || null,
        });
      }
      const deduped = new Map();
      for (const partial of partials) {
        if (!partial.file) continue;
        deduped.set(partialKey(partial), partial);
      }
      return {
        findingId: finding.findingId,
        partials: [...deduped.values()],
      };
    })
    .filter((entry) => entry.partials.length > 0);
}

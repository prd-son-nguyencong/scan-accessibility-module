import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { createSourceTraceInbox, traceAllFindings, applyTraceResultsToFindings } from '../../src/fix/trace/inbox.js';
import { buildTraceCandidatesFromFindings } from '../../src/fix/trace/candidates.js';
import { evaluateTracePrecision } from '../../src/fix/eval/poc-gates.js';

function findingIdFor(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

test('trace corpus via traceAllFindings meets >=99% precision on 100 distinct sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-corpus-'));
  try {
    const pagesDir = join(root, 'src', 'pages');
    mkdirSync(pagesDir, { recursive: true });
    const findings = [];
    for (let index = 0; index < 100; index += 1) {
      const rel = `src/pages/case-${String(index).padStart(3, '0')}.liquid`;
      const content = `{% layout %}\n<main>\n  <button id="btn-${index}">Go</button>\n</main>\n`;
      writeFileSync(join(root, rel), content);
      const preimage = buildSourcePreimage(content, 3);
      findings.push({
        findingId: findingIdFor(`case-${index}`),
        route: `/case-${index}`,
        pageState: 'initial',
        category: 'accessibility',
        layer: 'axe',
        nativeRuleId: 'button-name',
        canonicalRuleId: 'button-name',
        impact: 'critical',
        source: {
          file: rel,
          line: 3,
          confidence: 'high',
          method: 'instrumentation-manifest',
          preimageSha256: preimage.preimageSha256,
          preimageRange: preimage.range,
        },
      });
    }

    const inbox = createSourceTraceInbox({
      reportId: 'sha256:corpus',
      localRoot: root,
      sessionDir: join(root, 'scan-reports', 'fix-sessions', 'corpus'),
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    mkdirSync(inbox.sessionDir, { recursive: true });
    const traceResults = traceAllFindings(inbox, findings);
    const traced = applyTraceResultsToFindings(findings, traceResults);

    const cases = traced.map((finding) => {
      const result = traceResults.find((row) => row.findingId === finding.findingId);
      const partials = result?.partials || [];
      const ambiguous = partials.filter((row) => row.confidence === 'high').length > 1;
      const top = partials[0];
      return {
        ambiguous,
        expectedFile: finding.source?.file || null,
        expectedLine: finding.source?.line || null,
        actualFile: top?.file || null,
        actualLine: top?.line || null,
      };
    });

    const evalResult = evaluateTracePrecision(cases, { minPrecision: 0.99 });
    assert.equal(evalResult.ok, true, JSON.stringify(evalResult));
    assert.ok(evalResult.precision >= 0.99);
    assert.ok(evalResult.count >= 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

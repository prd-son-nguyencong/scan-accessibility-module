import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { requestFix } from './ai-client.js';
import { getProjectRoot } from '../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * AI Fixer
 *
 * Escalates violations not handled by deterministic rules to CIS AI.
 * For each violation:
 * 1. Loads source context (±10 lines around the violation)
 * 2. Sends to CIS (Haiku by default, Opus on escalation)
 * 3. Applies the returned fix to the source file (if confidence >= threshold)
 * 4. Returns a detailed fix log
 */
export async function runAiFixer(violations, options = {}) {
  const { dryRun = false, config = {} } = options;
  const results = [];

  // Deduplicate: group violations by source file
  const byFile = new Map();
  for (const v of violations) {
    const file = v.source?.file || 'unknown';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(v);
  }

  for (const [sourceFile, fileViolations] of byFile.entries()) {
    if (sourceFile === 'unknown') continue;

    const fullPath = path.join(ROOT, sourceFile);
    if (!existsSync(fullPath)) continue;

    const fileContent = readFileSync(fullPath, 'utf8');
    const lines = fileContent.split('\n');

    for (const violation of fileViolations.slice(0, 5)) { // Cap at 5 per file to control cost
      const lineNum = violation.source?.line || 1;
      const start = Math.max(0, lineNum - 10);
      const end = Math.min(lines.length, lineNum + 10);
      const sourceContext = lines.slice(start, end).join('\n');

      console.log(`    AI fix: ${violation.rule || violation.id} in ${sourceFile}`);

      const aiResult = await requestFix({ violation, sourceContext });

      if (aiResult.skipped) {
        console.log(`    Skipped: ${aiResult.explanation}`);
        results.push({ violation, file: sourceFile, skipped: true, reason: aiResult.explanation });
        continue;
      }

      if (!aiResult.fix || aiResult.confidence < 0.7) {
        console.log(`    Low confidence (${(aiResult.confidence || 0).toFixed(2)}) — flagged for manual review`);
        results.push({
          violation,
          file: sourceFile,
          applied: false,
          confidence: aiResult.confidence,
          explanation: aiResult.explanation,
        });
        continue;
      }

      if (dryRun) {
        console.log(`    [DRY RUN] Would apply fix (confidence: ${aiResult.confidence.toFixed(2)})`);
        results.push({ violation, file: sourceFile, dryRun: true, fix: aiResult.fix, confidence: aiResult.confidence });
        continue;
      }

      // Apply the fix: replace source context with AI-provided fix
      const contextLines = sourceContext.split('\n');
      const fixedContent = fileContent.replace(sourceContext, () => aiResult.fix);

      if (fixedContent !== fileContent) {
        writeFileSync(fullPath, fixedContent, 'utf8');
        console.log(`    Applied (confidence: ${aiResult.confidence.toFixed(2)}): ${aiResult.explanation?.slice(0, 80) || ''}`);
        results.push({
          violation,
          file: sourceFile,
          applied: true,
          confidence: aiResult.confidence,
          model: aiResult.model || 'unknown',
          explanation: aiResult.explanation,
        });
      } else {
        console.log(`    Fix had no diff — context may have changed`);
        results.push({ violation, file: sourceFile, applied: false, reason: 'Fix produced no diff' });
      }
    }
  }

  return results;
}

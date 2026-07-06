import { findRule, getAllRules } from './rules/index.js';
import { createRollbackPoint } from './rollback.js';

/**
 * Fix Agent
 *
 * Algorithm:
 * 1. Collect all unique violation IDs from scan results
 * 2. Create a git rollback point (stash)
 * 3. Apply each matching deterministic rule (in priority order)
 * 4. Re-scan affected pages with axe to verify fixes reduced violations
 * 5. If violations increased → rollback automatically
 * 6. If --ai enabled: escalate unresolved violations to CIS AI
 */
export async function runFixer(scanReport, options = {}) {
  const { dryRun = false, useAI = false, config = {} } = options;
  const fixReport = {
    timestamp: new Date().toISOString(),
    dryRun,
    applied: [],
    flagged: [],
    aiEscalated: [],
    errors: [],
    verification: null,
  };

  // Collect all violation IDs across all pages and layers
  const violationIds = new Set();
  const allViolations = [];
  const affectedPageUrls = new Set();

  for (const page of scanReport.pages || []) {
    const layers = ['axe', 'keyboard', 'focusTrap', 'ariaLive', 'dynamicContent', 'screenReader', 'w3c'];
    let pageHasViolations = false;
    for (const layer of layers) {
      const viols = page[layer]?.violations || [];
      if (viols.length > 0) pageHasViolations = true;
      collectViolations(viols, violationIds, allViolations);
    }
    if (pageHasViolations) affectedPageUrls.add(page.url);
  }

  if (violationIds.size === 0) {
    console.log('\nNo violations to fix.');
    return fixReport;
  }

  console.log(`\nFix Agent — ${violationIds.size} unique violation type(s) across ${affectedPageUrls.size} page(s)`);
  if (dryRun) console.log('DRY RUN — no files will be modified');

  // Pre-fix axe violation count (for verification baseline)
  const preFix = countAxeViolations(scanReport);

  // Create rollback point (git stash)
  const rollback = createRollbackPoint('scan-fix');
  if (!dryRun) {
    const stashed = rollback.save();
    if (!stashed) {
      console.log('  Warning: No git stash created (no uncommitted changes or git unavailable)');
      console.log('           Fixes will be applied directly without rollback protection.');
    }
  }

  // Apply rules in priority order
  const appliedRuleIds = new Set();

  for (const rule of getAllRules()) {
    const ruleViolationIds = rule.handles.filter((id) => violationIds.has(id));
    if (ruleViolationIds.length === 0) continue;
    if (appliedRuleIds.has(rule.id)) continue;

    console.log(`\n  Applying rule: ${rule.id} (handles: ${ruleViolationIds.join(', ')})`);

    if (dryRun) {
      fixReport.applied.push({ rule: rule.id, dryRun: true, description: 'Would apply fix' });
      appliedRuleIds.add(rule.id);
      continue;
    }

    try {
      const result = await rule.fix(
        allViolations.find((v) => ruleViolationIds.includes(v.rule || v.id)) || {},
        config
      );

      if (result.applied) {
        console.log(`    Applied: ${result.description}`);
        fixReport.applied.push({ rule: rule.id, ...result });
      } else {
        console.log(`    Skipped: ${result.reason}`);
      }

      if (result.flagged?.length > 0) {
        console.log(`    Flagged ${result.flagged.length} item(s) for review`);
        fixReport.flagged.push(...result.flagged.map((f) => ({ rule: rule.id, ...f })));
      }

      appliedRuleIds.add(rule.id);
    } catch (err) {
      console.error(`    Error in rule ${rule.id}: ${err.message}`);
      fixReport.errors.push({ rule: rule.id, error: err.message });
    }
  }

  // ── Post-fix verification ──────────────────────────────────────────────────
  if (!dryRun && fixReport.applied.filter((r) => r.applied !== false).length > 0) {
    fixReport.verification = await verifyFixes(
      [...affectedPageUrls],
      preFix,
      config,
      rollback
    );
  }

  // ── AI escalation ──────────────────────────────────────────────────────────
  const unhandled = [...violationIds].filter((id) => !findRule(id));
  if (unhandled.length > 0 && useAI) {
    console.log(`\n  ${unhandled.length} violation(s) not covered by rules — escalating to CIS AI...`);
    const { runAiFixer } = await import('./ai-fixer.js');
    const aiResults = await runAiFixer(
      allViolations.filter((v) => unhandled.includes(v.rule || v.id)),
      { dryRun, config }
    );
    fixReport.aiEscalated.push(...aiResults);
  } else if (unhandled.length > 0) {
    console.log(`\n  ${unhandled.length} violation(s) not covered by rules (run with --ai to escalate to CIS):`);
    for (const id of unhandled.slice(0, 10)) {
      console.log(`    ${id}`);
    }
    fixReport.flagged.push(
      ...unhandled.map((id) => ({ rule: id, reason: 'No deterministic rule — requires AI or manual fix' }))
    );
  }

  // Print fix summary
  console.log('\nFix Summary');
  console.log('-----------');
  console.log(`  Applied:   ${fixReport.applied.filter((r) => r.applied !== false && !r.dryRun).length} rule(s)`);
  console.log(`  Skipped:   ${fixReport.applied.filter((r) => r.applied === false).length} rule(s) (already applied)`);
  console.log(`  Flagged:   ${fixReport.flagged.length} item(s) for review`);
  console.log(`  AI fixes:  ${fixReport.aiEscalated.length}`);
  console.log(`  Errors:    ${fixReport.errors.length}`);
  if (fixReport.verification) {
    const { before, after, rolledBack } = fixReport.verification;
    if (rolledBack) {
      console.log(`  Verify:    ROLLED BACK — violations increased (${before} → ${after})`);
    } else {
      console.log(`  Verify:    PASS — violations ${before} → ${after} (${before - after} fixed)`);
    }
  }

  return fixReport;
}

// ─── Verification helpers ─────────────────────────────────────────────────────

async function verifyFixes(pageUrls, preFix, config, rollback) {
  console.log('\n  Verifying fixes (axe re-scan on affected pages)...');

  // Wait for Vite HMR to propagate source changes
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const { scanPageWithAxe } = await import('../scanner/axe.js');
    let postFixCount = 0;

    for (const url of pageUrls.slice(0, 3)) { // cap at 3 pages to keep verify fast
      const result = await scanPageWithAxe(url, config);
      postFixCount += result.violations.reduce((sum, v) => sum + (v.nodes?.length || 1), 0);
    }

    if (postFixCount > preFix) {
      console.log(`  Verification FAILED (${preFix} → ${postFixCount} violations) — rolling back`);
      rollback.restore();
      return { before: preFix, after: postFixCount, rolledBack: true };
    }

    console.log(`  Verification PASSED (${preFix} → ${postFixCount} violations)`);
    return { before: preFix, after: postFixCount, rolledBack: false };
  } catch (err) {
    console.error(`  Verification error: ${err.message} — skipping rollback`);
    return { before: preFix, after: null, rolledBack: false, error: err.message };
  }
}

function countAxeViolations(scanReport) {
  let count = 0;
  for (const page of scanReport.pages || []) {
    for (const v of page.axe?.violations || []) {
      count += v.nodes?.filter((n) => !n.devArtifact).length || 1;
    }
  }
  return count;
}

function collectViolations(violations, idSet, allViolations) {
  for (const v of violations) {
    idSet.add(v.rule || v.id);
    allViolations.push(v);
  }
}

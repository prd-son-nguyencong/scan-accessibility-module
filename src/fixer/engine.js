import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { sortViolations, groupViolations } from '../schema.js';
import { findRule, getAllRules } from './rules/index.js';
import { createRollbackPoint } from './rollback.js';
import { getProjectRoot } from '../utils/paths.js';
import { isThirdPartyHtml } from '../utils/third-party.js';
import { presentFixTerminal } from './presenter.js';

const ROOT = getProjectRoot();

/**
 * Fix Engine — routes violations through deterministic rules or AI modes.
 *
 * Flow:
 * 1. Load violations from latest.json, filter third-party
 * 2. Group by source file, sort by priority
 * 3. Deterministic rules → generate patch directly
 * 4. Non-deterministic → route to selected AI mode
 * 5. Present diffs (terminal or browser UI)
 * 6. Apply accepted patches, targeted re-scan
 */
export async function runFixEngine(violations, options = {}) {
  const {
    fixMode = 'claude',
    dryRun = false,
    useUI = false,
    useAI = false,
    agent = false,
    config = {},
    includeThirdParty = false,
  } = options;

  const session = {
    timestamp: new Date().toISOString(),
    mode: fixMode,
    dryRun,
    fixes: [],
    skipped: [],
    errors: [],
  };

  // Filter out third-party injected elements (unless --include-third-party).
  // Selectors are config-driven via config.thirdParty.selectors.
  const thirdPartySelectors = config?.thirdParty?.selectors;
  const actionable = violations.filter((v) => {
    if (includeThirdParty) return true;
    const html = v.element?.outerHTML || '';
    if (isThirdPartyHtml(html, thirdPartySelectors)) {
      session.skipped.push({ ...v, reason: 'known-third-party' });
      return false;
    }
    return true;
  });

  if (actionable.length === 0) {
    console.log('\nNo actionable violations to fix.');
    return session;
  }

  const sorted = sortViolations(actionable);

  // Auto-promote violations to deterministic when a fixer rule handles them
  for (const v of sorted) {
    if (!v.fix?.deterministic && findRule(v.ruleId)) {
      v.fix = { ...v.fix, deterministic: true };
    }
  }

  const byFile = groupViolations(sorted, (v) => v.source?.file || 'unknown');
  const isIDEMode = ['cursor', 'vscode', 'windsurf'].includes(fixMode);

  console.log(`\nFix Engine — ${actionable.length} violation(s), mode: ${fixMode}`);
  if (dryRun) console.log('DRY RUN — no files will be modified\n');

  // IDE modes: write context files, no interactive UI
  if (isIDEMode) {
    const modeModule = await import(`./modes/${fixMode}.js`);
    await modeModule.writeFixContext(sorted, config);
    console.log(`Fix context written for ${fixMode} IDE mode.`);
    session.fixes = sorted.map((v) => ({ ruleId: v.ruleId, mode: fixMode, action: 'ide-context' }));

    const sessionPath = path.join(ROOT, 'scan-reports', `fix-session-${Date.now()}.json`);
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    console.log(`Fix session: ${sessionPath}`);
    return session;
  }

  // Create rollback point
  const rollback = createRollbackPoint('scan-fix-engine');
  if (!dryRun) rollback.save();

  // Process each violation
  const pendingPatches = [];

  for (const violation of sorted) {
    const rule = findRule(violation.ruleId);
    let patch = null;

    if (violation.fix?.deterministic && rule) {
      // Deterministic fix — rule engine generates patch
      try {
        const result = await rule.fix(violation, config);
        if (result.applied) {
          patch = { violation, patch: result.patch || result.description, source: 'rule-engine' };
        }
      } catch (err) {
        session.errors.push({ ruleId: violation.ruleId, error: err.message });
      }
    } else if (!violation.fix?.deterministic && useAI && !isIDEMode) {
      try {
        const { runAiFixer } = await import('./ai-fixer.js');
        const aiResults = await runAiFixer([violation], { dryRun, config });
        const aiResult = aiResults[0];
        if (aiResult?.applied || aiResult?.dryRun) {
          patch = { violation, patch: aiResult.fix, source: 'ai-fixer' };
        }
      } catch (err) {
        session.errors.push({ ruleId: violation.ruleId, error: `AI: ${err.message}` });
      }
    } else if (!violation.fix?.deterministic && !isIDEMode) {
      patch = { violation, patch: null, source: fixMode, pending: true };
    }

    if (patch) pendingPatches.push(patch);
  }

  const API_MODES = ['cis', 'claude', 'codex'];

  // Present fixes
  if (useUI) {
    if (!API_MODES.includes(fixMode)) {
      console.log(`\nBrowser UI requires an API mode (${API_MODES.join(', ')}).`);
      console.log(`Use --fix-mode cis|claude|codex with --ui.\n`);
      console.log(`Falling back to ${fixMode} IDE context output...\n`);
      const modeModule = await import(`./modes/${fixMode}.js`);
      await modeModule.writeFixContext(sorted, config);
    } else {
      const { startFixServer } = await import('./ui/server.js');
      const { FixState } = await import('./ui/state.js');
      const state = new FixState(sorted, { fixMode, config });
      const serverInstance = await startFixServer(state, {
        fixMode,
        dryRun,
      });
      console.log(`\nFix dashboard: http://localhost:${serverInstance.port}`);
      console.log('Open in browser to review and apply fixes.');
      console.log('Press Ctrl+C to stop.\n');
      await serverInstance.waitForClose();

      session.fixes = state.getAll()
        .filter((v) => v.status === 'accepted')
        .map((v) => ({ ruleId: v.ruleId, file: v.file, mode: v.mode, action: 'accepted' }));
    }
  } else if (!agent) {
    const accepted = await presentFixTerminal(pendingPatches, { fixMode, dryRun });
    for (const fix of accepted) {
      session.fixes.push({
        ruleId: fix.violation.ruleId,
        file: fix.violation.source?.file,
        mode: fix.source,
        action: 'accepted',
      });
    }

    // Apply accepted patches
    if (!dryRun && accepted.length > 0) {
      applyPatches(accepted);
      console.log(`\nApplied ${accepted.length} fix(es).`);
    }
  } else if (agent) {
    // Autonomous mode — accept all deterministic fixes
    const autoAccepted = pendingPatches.filter((p) => p.source === 'rule-engine');
    if (!dryRun && autoAccepted.length > 0) {
      applyPatches(autoAccepted);
      console.log(`\nAgent mode: auto-applied ${autoAccepted.length} deterministic fix(es).`);
    }
    session.fixes = autoAccepted.map((p) => ({
      ruleId: p.violation.ruleId,
      mode: 'rule-engine',
      action: 'auto-accepted',
    }));
  }

  // Targeted re-scan guidance — collect affected pages and layers
  const affectedFiles = new Set();
  const affectedLayers = new Set();
  for (const fix of session.fixes) {
    if (fix.file) affectedFiles.add(fix.file);
    const v = sorted.find((s) => s.ruleId === fix.ruleId);
    if (v?.layer) affectedLayers.add(v.layer);
  }
  session.rescan = {
    files: [...affectedFiles],
    layers: [...affectedLayers],
    command: affectedFiles.size > 0
      ? `pnpm scan --page ${[...affectedFiles].map((f) => f.replace(/^src\/pages\//, '').replace(/\.liquid$/, '')).join(' --page ')}`
      : null,
  };

  if (session.fixes.length > 0 && session.rescan.command) {
    console.log(`\nTo verify fixes, re-scan affected pages:`);
    console.log(`  ${session.rescan.command}`);
  }

  // Save session
  const sessionPath = path.join(ROOT, 'scan-reports', `fix-session-${Date.now()}.json`);
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  console.log(`Fix session: ${sessionPath}`);

  return session;
}

function applyPatches(patches) {
  const filePatches = new Map();
  for (const p of patches) {
    const file = p.violation.source?.file;
    if (!file || !p.patch) continue;
    if (!filePatches.has(file)) filePatches.set(file, []);
    filePatches.get(file).push(p);
  }

  for (const [file, fPatches] of filePatches) {
    const fullPath = path.join(ROOT, file);
    if (!existsSync(fullPath)) continue;
    let content = readFileSync(fullPath, 'utf8');
    for (const fp of fPatches) {
      if (typeof fp.patch === 'string' && fp.patch.includes('→')) {
        const [before, after] = fp.patch.split('→').map((s) => s.trim());
        content = content.replace(before, after);
      }
    }
    writeFileSync(fullPath, content, 'utf8');
  }
}

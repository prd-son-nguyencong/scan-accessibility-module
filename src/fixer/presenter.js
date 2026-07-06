import { createInterface } from 'readline';

const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

/**
 * Terminal diff presenter — shows IDE-style diffs for each fix.
 * Returns the array of accepted fix objects.
 */
export async function presentFixTerminal(patches, options = {}) {
  const { fixMode = 'claude', dryRun = false } = options;
  const accepted = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log(`\n${COLORS.bold}Fix Presenter${COLORS.reset} — ${patches.length} fix(es) to review\n`);
  console.log(`${COLORS.dim}[a] Accept  [r] Reject  [f] Re-fix  [s] Skip all like this  [q] Quit${COLORS.reset}\n`);

  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    const v = p.violation;

    // Lazy API call for non-deterministic fixes
    if (p.pending && !p.patch) {
      process.stdout.write(`${COLORS.dim}Generating fix via ${fixMode}...${COLORS.reset}`);
      try {
        const modeModule = await import(`./modes/${fixMode}.js`);
        const result = await modeModule.generateFix(v);
        p.patch = result.patch;
        p.explanation = result.explanation;
        process.stdout.write('\r\x1b[2K');
      } catch (err) {
        process.stdout.write(`\r\x1b[2K${COLORS.red}API error: ${err.message}${COLORS.reset}\n`);
        continue;
      }
    }

    // Print the diff
    const file = v.source?.file || 'unknown';
    const line = v.source?.line || '?';
    console.log(`${COLORS.bold}[${i + 1}/${patches.length}]${COLORS.reset} ${v.ruleId} — P${v.priority} — ${v.impact}`);
    console.log(`${COLORS.dim}${file}:${line}${COLORS.reset}`);
    console.log();

    console.log(`<<<<<<< Current · ${file}:${line}`);
    if (v.element?.outerHTML) {
      const snippet = v.element.outerHTML.slice(0, 200);
      console.log(`${COLORS.red}-  ${snippet}${COLORS.reset}`);
    }
    console.log(`======= Incoming fix · ${v.layer} · ${v.ruleId} · P${v.priority} · ${v.wcagRef || ''}`);
    if (p.patch) {
      console.log(`${COLORS.green}+  ${typeof p.patch === 'string' ? p.patch.slice(0, 200) : JSON.stringify(p.patch).slice(0, 200)}${COLORS.reset}`);
    } else {
      console.log(`${COLORS.yellow}   ${v.fix?.hint || 'No patch available'}${COLORS.reset}`);
    }
    console.log('>>>>>>>');
    console.log();

    if (dryRun) {
      console.log(`${COLORS.dim}(dry run — skipping)${COLORS.reset}\n`);
      continue;
    }

    let action = '';
    while (true) {
      const answer = await ask(`  Action: `);
      action = answer.trim().toLowerCase();

      if (action === 'a') {
        accepted.push(p);
        console.log(`${COLORS.green}  Accepted${COLORS.reset}\n`);
        break;
      } else if (action === 'r') {
        const reason = await ask(`  Reason (optional): `);
        p.rejected = true;
        p.rejectReason = reason.trim() || null;
        console.log(`${COLORS.red}  Rejected${reason.trim() ? ` — ${reason.trim()}` : ''}${COLORS.reset}\n`);
        break;
      } else if (action === 'f') {
        const comment = await ask(`  Your hint for re-fix: `);
        if (!comment.trim()) {
          console.log(`${COLORS.dim}  No comment provided, skipping re-fix${COLORS.reset}\n`);
          continue;
        }
        process.stdout.write(`${COLORS.dim}  Re-generating fix via ${fixMode}...${COLORS.reset}`);
        try {
          const modeModule = await import(`./modes/${fixMode}.js`);
          const result = await modeModule.generateFix(v, { userHint: comment.trim() });
          p.patch = result.patch;
          p.explanation = result.explanation;
          process.stdout.write('\r\x1b[2K');
          console.log(`${COLORS.cyan}  Revised fix:${COLORS.reset}`);
          if (p.patch) {
            console.log(`${COLORS.green}+  ${typeof p.patch === 'string' ? p.patch.slice(0, 300) : JSON.stringify(p.patch).slice(0, 300)}${COLORS.reset}`);
          }
          if (p.explanation) {
            console.log(`${COLORS.dim}  AI: ${p.explanation.slice(0, 200)}${COLORS.reset}`);
          }
          console.log();
        } catch (err) {
          process.stdout.write(`\r\x1b[2K${COLORS.red}  Re-fix error: ${err.message}${COLORS.reset}\n`);
        }
        continue;
      } else if (action === 'q') {
        console.log(`${COLORS.yellow}  Quitting — ${accepted.length} fix(es) accepted so far${COLORS.reset}`);
        break;
      } else if (action === 's') {
        const skipRule = v.ruleId;
        const skipped = patches.filter((pp, j) => j > i && pp.violation.ruleId === skipRule).length;
        console.log(`${COLORS.yellow}  Skipping ${skipped} more "${skipRule}" violations${COLORS.reset}\n`);
        patches.splice(
          i + 1,
          0,
          ...patches.splice(i + 1).filter((pp) => pp.violation.ruleId !== skipRule)
        );
        break;
      } else {
        console.log(`${COLORS.dim}  Unknown action. Use [a]ccept, [r]eject, [f] re-fix, [s]kip all, [q]uit${COLORS.reset}`);
      }
    }
    if (action === 'q') break;
  }

  rl.close();
  return accepted;
}

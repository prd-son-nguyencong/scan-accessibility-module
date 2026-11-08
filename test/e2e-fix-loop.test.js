import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startParadoxSite, PARADOX_SITE_DIR } from './helpers/paradox-site-server.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'test/fixtures/paradox-site');
const CLI = path.join(REPO, 'bin/ada-scan.js');

function run(root, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: root, env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_DEPLOYMENT_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 240_000);
  return new Promise((resolve) => child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); }));
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `expected exactly one ${from}`);
  return text.replace(from, to);
};

// The developer's edits, keyed by the element a task points at. `built` is the same edit in the served HTML (scripted "rebuild").
const FIXES = {
  'defect-img': ['<img class="defect-img" src="/pixel.svg" width="40" height="40">', '<img class="defect-img" src="/pixel.svg" width="40" height="40" alt="Acme team photo">'],
  'defect-icon-button': ['<button class="defect-icon-button" type="button">', '<button class="defect-icon-button" type="button" aria-label="Close menu">'],
};
const UNRELATED = ['<p>Join a team that values you.</p>', '<p>Join a team that truly values you.</p>'];

async function editFile(file, [from, to]) {
  await writeFile(file, replaceOnce(await readFile(file, 'utf8'), from, to));
}

test('scan, export tasks, developer fix, rescan: fixed ids are exactly the fixed tasks; a wrong fix fixes nothing', { timeout: 600_000 }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ada-fix-loop-'));
  const siteDir = path.join(tmp, 'site');
  const rootGood = path.join(tmp, 'good');
  const rootWrong = path.join(tmp, 'wrong');
  await cp(PARADOX_SITE_DIR, siteDir, { recursive: true });
  await cp(path.join(FIXTURE, 'src'), path.join(rootGood, 'src'), { recursive: true });
  // The no-op build command stands in for the host build; the static HTML in siteDir is the "built" site.
  await writeFile(path.join(rootGood, '.scan-config.json'), JSON.stringify({ buildCommand: 'node -e 0' }));
  const site = await startParadoxSite({ host: '127.0.0.1', dir: siteDir });
  const scanArgs = ['--url', `${site.url}/`, '--layers', 'axe,accessScan', '--no-psi', '--no-fail'];
  try {
    // (1) scan -> report A
    const a = await run(rootGood, scanArgs);
    assert.match(a.out, /No comparison in this scan|Comparison: skipped/);
    const reportA = await readJson(path.join(rootGood, '.ada-scan/latest.json'));
    const total = reportA.pages[0].findings.length;
    assert.ok(total >= 10, `fixture should have seeded findings, got ${total}`);
    assert.ok(reportA.pages[0].findings.some((f) => f.source?.file === 'src/pages/index.liquid' && f.source.line === 10), 'image-alt is traced to index.liquid:10');
    await cp(rootGood, rootWrong, { recursive: true }); // both rescans start from report A as the previous scan

    // (2) fix --export -> tasks
    const exp = await run(rootGood, ['fix', '--export', '--source', rootGood, '--out-dir', path.join(rootGood, '.ada-scan')]);
    assert.equal(exp.code, 0, exp.out);
    const tasksDir = path.join(rootGood, '.ada-scan/tasks');
    const tasks = await Promise.all((await readdir(tasksDir)).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(tasksDir, n))));
    // Default export is actionable only: heuristic single-engine findings are needs-review and get no task.
    const actionable = reportA.pages[0].findings.filter((f) => f.verdict !== 'needs-review').length;
    assert.ok(actionable < total, 'the fixture has needs-review findings that are not exported');
    assert.equal(tasks.length, actionable, 'one task per actionable finding on this fixture');
    // Independent expectation: the unlabelled button and the img are each reported by axe and accessScan, which merge into ONE finding (one task) per element,
    // exported under the primary engine's rule id (button-name, image-alt).
    // (VisibilityMismatch is a heuristic: needs-review, so it gets no task.)
    const fixedTasks = tasks.filter((t) => ['button-name', 'image-alt'].includes(t.rule));
    assert.deepEqual(fixedTasks.map((t) => t.rule).sort(), ['button-name', 'image-alt']);
    const expectedFixed = fixedTasks.flatMap((t) => t.ids).sort();

    // (3) developer applies the traced tasks' edits to the source copy, then "rebuilds" the served HTML
    for (const [key, edit] of Object.entries(FIXES)) {
      const task = tasks.find((t) => t.element.html.includes(key) && t.source);
      assert.ok(task, `a traced task for ${key}`);
      const src = path.join(rootGood, task.source.file);
      assert.ok((await readFile(src, 'utf8')).split('\n')[task.source.line - 1].includes(key), `${task.source.file}:${task.source.line} is the ${key} line`);
      await editFile(src, edit);
      await editFile(path.join(siteDir, 'index.html'), edit);
    }

    // (4) rescan compares with report A by default
    const b = await run(rootGood, scanArgs);
    assert.match(b.out, new RegExp(`Comparison vs previous scan \\(.*\\): fixed ${fixedTasks.length}, remaining ${actionable - fixedTasks.length}, new 0`), b.out);
    const cmp = (await readJson(path.join(rootGood, '.ada-scan/latest.json'))).comparison;
    assert.deepEqual(cmp.fixed.map((f) => f.stableId).sort(), expectedFixed);
    assert.deepEqual([cmp.totals.fixed, cmp.totals.remaining, cmp.totals.new], [fixedTasks.length, actionable - fixedTasks.length, 0]);

    // wrong fix: an unrelated line changes, every finding stays
    await cp(PARADOX_SITE_DIR, siteDir, { recursive: true });
    await editFile(path.join(siteDir, 'index.html'), UNRELATED);
    await editFile(path.join(rootWrong, 'src/pages/index.liquid'), UNRELATED);
    const w = await run(rootWrong, scanArgs);
    assert.match(w.out, new RegExp(`Comparison vs previous scan \\(.*\\): fixed 0, remaining ${actionable}, new 0`), w.out);
    const wrong = (await readJson(path.join(rootWrong, '.ada-scan/latest.json'))).comparison;
    assert.deepEqual([wrong.fixed.length, wrong.remaining.length, wrong.new.length], [0, actionable, 0]);
  } finally {
    await site.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

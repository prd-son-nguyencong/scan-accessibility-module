import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { runBench } from '../scripts/bench/access-scan-bench.js';
import { getSharedBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { checkDeadline, createRuleDeadline, deadlineStorage } from '../src/scanner/access-scan/engine/deadline.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import { scanWithAccessScan } from '../src/scanner/access-scan/index.js';
import { buildSnapshotIndexes } from '../src/scanner/access-scan/runtime/graph-relationships.js';
import { explicitLabelText } from '../src/scanner/access-scan/evaluators/lib/visible-label.js';

/** @type {import('playwright').Browser} */
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

test('synthetic 4000-element page scans complete within a generous bound', async () => {
  const result = await runBench(4000);
  assert.ok(result.elements >= 4000);
  assert.equal(result.statuses.error ?? 0, 0);
  assert.equal(result.statuses.timeout ?? 0, 0);
  assert.ok(result.statuses.complete > 0);
  assert.ok(result.scanMs < 60_000, `scan took ${result.scanMs}ms`);
});

test('two iframes under different parents get distinct frame paths and element ids', async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div><iframe srcdoc="<label for='x'>A</label><input id='x'>"></iframe></div>
    <section><iframe srcdoc="<label for='x'>B</label><input id='x'>"></iframe></section>
  </body></html>`);
  const session = await createScanSession(page);
  const inputs = session.snapshot.elements.filter((element) => element.tag === 'input');
  assert.equal(inputs.length, 2);
  assert.notDeepEqual(inputs[0].framePath, inputs[1].framePath);
  assert.deepEqual(inputs.map((element) => element.framePath).sort(), [[0], [1]]);
  assert.notEqual(inputs[0].id, inputs[1].id);
  // the same DOM id in two frames must not merge: each input resolves to its own frame's label
  const indexes = buildSnapshotIndexes(session.snapshot);
  const texts = inputs.map((input) => explicitLabelText(session.snapshot, indexes, input).trim()).sort();
  assert.deepEqual(texts, ['A', 'B']);
  await page.close();
});

test('cooperative deadline throws from a synchronous loop and the run continues', async () => {
  const expired = createRuleDeadline({ timeoutMs: 0 });
  assert.throws(
    () => deadlineStorage.run(expired, () => checkDeadline()),
    (error) => error.errorCode === 'rule_timeout',
  );
  assert.doesNotThrow(() => checkDeadline());

  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><main><label for="a">A</label><input id="a"><a href="/x">x</a></main></body></html>');
  const session = await createScanSession(page);
  const registry = await getSharedBuiltInRuleRegistry();
  const { executionRecords } = await runRules({
    registry,
    context: { snapshot: session.snapshot, session, url: 'about:blank' },
    ruleTimeoutMs: 0,
    skipRules: registry.getActiveRuleIds().filter((id) => /^(FocusNotObscuredFooter|StickyHeaderObscuresFocus)$/.test(id)),
  });
  assert.ok(executionRecords.some((record) => record.status === 'timeout'));
  assert.ok(executionRecords.length > 50);
  await page.close();
});

test('an aborted scan starts no further evaluators', async () => {
  const registry = await getSharedBuiltInRuleRegistry();
  const controller = new AbortController();
  controller.abort();
  const { executionRecords } = await runRules({ registry, context: {}, signal: controller.signal });
  const checked = executionRecords.filter((record) => record.checks.length > 0 && record.status !== 'skipped');
  assert.ok(checked.length > 0);
  for (const record of checked) {
    assert.equal(record.status, 'error');
    assert.equal(record.errorCode, 'scan_cancelled');
  }
});

test('TargetSize with the sorted-peer lookup matches a brute-force pairwise check', async () => {
  let seed = 7;
  const rand = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
  const buttons = Array.from({ length: 250 }, (_, i) => (
    `<button style="position:absolute;left:${rand(600)}px;top:${rand(900)}px;width:${8 + rand(40)}px;height:${8 + rand(40)}px">b${i}</button>`
  )).join('');
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><main>${buttons}</main></body></html>`);
  const session = await createScanSession(page);

  const targets = session.snapshot.elements.filter((e) => (
    e.tag === 'button' && e.rendered && e.focusable && e.rect.width > 0 && e.rect.height > 0
  ));
  const small = (e) => e.rect.width < 24 || e.rect.height < 24;
  const center = (e) => ({ x: e.rect.x + e.rect.width / 2, y: e.rect.y + e.rect.height / 2 });
  const expected = targets.filter(small).filter((e) => targets.some((peer) => {
    if (peer.id === e.id) return false;
    const c = center(e);
    if (small(peer)) return Math.hypot(c.x - center(peer).x, c.y - center(peer).y) < 24;
    const dx = Math.max(peer.rect.x - c.x, 0, c.x - (peer.rect.x + peer.rect.width));
    const dy = Math.max(peer.rect.y - c.y, 0, c.y - (peer.rect.y + peer.rect.height));
    return Math.hypot(dx, dy) < 12;
  })).length;

  const registry = await getSharedBuiltInRuleRegistry();
  const violations = await scanWithAccessScan(page, 'about:blank', {
    session,
    skipNavigation: true,
    activateContent: false,
    skipRules: registry.getActiveRuleIds().filter((id) => id !== 'TargetSize'),
  });
  assert.ok(expected > 0 && expected < targets.length);
  assert.equal(violations.filter((v) => v.ruleId === 'TargetSize').length, expected);
  await page.close();
});

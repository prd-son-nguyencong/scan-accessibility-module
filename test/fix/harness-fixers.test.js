// Fixer adapters (recipes, CIS against a mock server on 127.0.0.1, external diff) on the seeded-fault corpus. No browser, no real CIS.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS_DIR, applyManifestEdits, contextFor, loadManifest, taskFor } from '../../scripts/lib/fix-corpus.js';
import { createCisFixer, createExternalFixer, createRecipesFixer, injectionIn, parseUnifiedDiff, summarizeGateEvidence } from '../../src/fix/harness/fixers/index.js';
import { createCisTransport } from '../../src/fix/cis/transport.js';

const work = mkdtempSync(join(tmpdir(), 'fixers-'));
after(() => rmSync(work, { recursive: true, force: true }));
const manifest = loadManifest();
const site = (id) => manifest.sites.find((s) => s.id === id);
const defect = (id) => manifest.sites.flatMap((s) => s.defects.map((d) => [s, d])).find(([, d]) => d.id === id);
const copy = (s) => { const d = mkdtempSync(join(work, 'c-')); cpSync(join(CORPUS_DIR, s.dir), d, { recursive: true }); return d; };
const expectedAfter = (s, d) => { const r = copy(s); return applyManifestEdits(r, d.expectedFix.edits); };

// ------------------------------------------------------------------ recipes

const recipes = createRecipesFixer();
const recipeDefects = manifest.sites.flatMap((s) => s.defects.filter((d) => d.recipe).map((d) => [s, d]));

test('recipes reproduce the expected fix byte for byte on every recipe defect of the corpus', async () => {
  assert.ok(recipeDefects.length >= 11);
  for (const [s, d] of recipeDefects) {
    const task = taskFor(s, d);
    const r = await recipes.propose(task, contextFor(join(CORPUS_DIR, s.dir), s, task));
    assert.ok(!r.declined, `${d.id}: ${r.declined} ${r.detail || ''}`);
    const exp = expectedAfter(s, d);
    assert.deepEqual(Object.fromEntries(r.files.map((f) => [f.path, f.after])), exp, d.id);
    assert.ok(r.rationale && r.confidence > 0);
  }
});

test('recipes decline non-recipe rules and design-locked contrast', async () => {
  for (const id of ['lantern-label', 'quarry-heading-order', 'willow-focus-visible']) {
    const [s, d] = defect(id); const t = taskFor(s, d);
    assert.equal((await recipes.propose(t, contextFor(join(CORPUS_DIR, s.dir), s, t))).declined, 'NO_RECIPE', id);
  }
  const [s, d] = defect('willow-contrast'); const t = taskFor(s, d);
  assert.equal((await recipes.propose(t, contextFor(join(CORPUS_DIR, s.dir), s, t))).declined, 'DESIGN_LOCKED');
});

/** Task over inline text: one file `a.liquid`, source line n, optional extra context. */
const inline = (rule, text, n, html, extra = {}) => [{ rule, source: { file: 'a.liquid', line: n }, element: { html }, evidence: extra.evidence || [], ...(extra.task || {}) }, { files: { 'a.liquid': { text } }, ...(extra.context || {}) }];
const reason = async (...args) => (await recipes.propose(...inline(...args))).declined;
const out = async (...args) => (await recipes.propose(...inline(...args))).files?.[0].after;

test('recipes: viewport removes only user-scalable=no and maximum-scale below 5', async () => {
  const m = (c) => `<meta name="viewport" content="${c}">`;
  assert.equal(await out('meta-viewport', m('width=device-width, user-scalable=0, maximum-scale=2'), 1, m('x')), m('width=device-width'));
  assert.equal(await out('meta-viewport', m('width=device-width,maximum-scale=1.0'), 1, m('x')), m('width=device-width'));
  assert.equal(await reason('meta-viewport', m('width=device-width, maximum-scale=5'), 1, m('x')), 'NOTHING_TO_REMOVE');
  assert.equal(await reason('meta-viewport', `<meta name="viewport" content="{{data:vp}}, user-scalable=no">`, 1, m('x')), 'DYNAMIC_OR_MISSING_CONTENT');
});

test('recipes: ambiguous, multi-line and dynamic cases decline', async () => {
  const two = '<button title="Menu"></button><button title="Close"></button>';
  assert.equal(await reason('button-name', two, 1, '<button>'), 'AMBIGUOUS_LINE');
  assert.equal(await reason('button-name', '<button\n  class="x">\n<span>Menu</span></button>', 1, '<button>'), 'TAG_SPANS_LINES');
  assert.equal(await reason('button-name', '<button class="x"></button>', 1, '<button>'), 'NO_SAFE_LABEL_SOURCE');
  assert.equal(await reason('button-name', '<button title="{{data:t}}"></button>', 1, '<button>'), 'NO_SAFE_LABEL_SOURCE');
  assert.equal(await out('button-name', '<button class="x" title="Open filters">{% render "i" %}</button>', 1, '<button>'), '<button class="x" title="Open filters" aria-label="Open filters">{% render "i" %}</button>');
  assert.equal(await reason('link-name', '<a href="/x"></a>', 1, '<a href="/x">'), 'NO_SAFE_LABEL_SOURCE');
  assert.equal(await out('link-name', '<a href="/x" class="{{ c }}"><span aria-hidden="true">Jobs</span></a>', 1, '<a href="/x">'), '<a href="/x" class="{{ c }}" aria-label="Jobs"><span aria-hidden="true">Jobs</span></a>');
});

test('recipes: image-alt needs decorative evidence, a figcaption or a title; never a file name', async () => {
  assert.equal(await reason('image-alt', '<img src="/team-photo.jpg">', 1, '<img src="/team-photo.jpg">'), 'NO_SAFE_LABEL_SOURCE');
  assert.equal(await out('image-alt', '<img src="/a.jpg" role="presentation">', 1, '<img src="/a.jpg" role="presentation">'), '<img src="/a.jpg" role="presentation" alt="">');
  assert.equal(await reason('image-alt', '<img src="/a.jpg" alt="x">', 1, '<img>'), 'ALT_ALREADY_PRESENT');
  assert.equal(await out('image-alt', '<img src="/a.jpg" title="Our office">', 1, '<img>'), '<img src="/a.jpg" title="Our office" alt="Our office">');
  assert.equal(await reason('image-alt', '<img src="/a.jpg" title="photo.jpg">', 1, '<img>'), 'NO_SAFE_LABEL_SOURCE');
});

test('recipes: aria-expanded needs a script that toggles it; aria-controls only when the panel id exists', async () => {
  const btn = '<button class="t" data-target="#panel">Open</button>\n<div id="panel" hidden></div>';
  const ro = { 'a.js': 'btn.setAttribute("aria-expanded", "true")' };
  assert.equal(await reason('disclosure-missing-aria-expanded', btn, 1, '<button>'), 'SCRIPT_UNKNOWN');
  const withScript = (text, ro2 = ro) => recipes.propose(...inline('disclosure-missing-aria-expanded', text, 1, '<button>', { context: { readonly: ro2 } }));
  assert.equal((await withScript(btn)).files[0].after.split('\n')[0], '<button class="t" data-target="#panel" aria-expanded="false" aria-controls="panel">Open</button>');
  assert.equal((await withScript(btn.replace('id="panel"', 'id="other"'))).files[0].after.split('\n')[0], '<button class="t" data-target="#panel" aria-expanded="false">Open</button>');
  assert.equal((await withScript(btn, { 'a.js': 'noop()' })).declined, 'SCRIPT_DOES_NOT_TOGGLE_ARIA_EXPANDED');
});

test('recipes: nav label from purpose, unique, else decline', async () => {
  assert.equal(await out('landmark-unique', '<nav class="breadcrumb">', 1, '<nav>'), '<nav class="breadcrumb" aria-label="Breadcrumb">');
  assert.equal(await reason('landmark-unique', '<nav class="x">', 1, '<nav>'), 'PURPOSE_NOT_DERIVABLE');
  assert.equal(await out('landmark-unique', '<footer>\n<nav class="x">\n</footer>', 2, '<nav>'), '<footer>\n<nav class="x" aria-label="Footer">\n</footer>');
  assert.equal(await reason('landmark-unique', '<nav id="main-nav" class="a">\n<nav aria-label="Main">', 1, '<nav>'), 'LABEL_NOT_UNIQUE');
});

test('recipes: html lang and title need a trustworthy source', async () => {
  const page = (rule, text, ctx) => recipes.propose({ rule, element: {}, allowlist: [{ file: 'a.liquid' }] }, { files: { 'a.liquid': { text } }, ...ctx });
  assert.equal((await page('html-has-lang', '<html>\n<body></body>')).declined, 'LANGUAGE_UNKNOWN');
  assert.equal((await page('html-has-lang', '<html>\n', { siteLang: 'fr-CA' })).files[0].after, '<html lang="fr-CA">\n');
  assert.equal((await page('html-has-lang', '<html>\n', { siteLang: 'not a lang' })).declined, 'LANGUAGE_UNKNOWN');
  assert.equal((await page('document-title', '<head>\n  <meta charset="utf-8">\n</head>\n<h1>Jobs</h1>')).files[0].after, '<head>\n  <meta charset="utf-8">\n  <title>Jobs</title>\n</head>\n<h1>Jobs</h1>');
  assert.equal((await page('document-title', '<head>\n</head>\n<h1>{{data:t}}</h1>')).declined, 'NO_SAFE_TITLE_SOURCE');
  assert.equal((await page('skip-link-missing', '<body>\n<main></main>\n</body>')).declined, 'SR_ONLY_CLASS_NOT_IN_PROJECT');
  assert.equal((await page('skip-link-missing', '<body>\n<main id="{{ x }}"></main>', { readonly: { 'a.css': '.sr-only{}' } })).declined, 'MAIN_ID_DYNAMIC');
});

test('recipes: noopener, autocomplete and decorative cases keep tags intact', async () => {
  assert.equal(await out('link-target-blank-rel', '<a href="{{data:u}}" target="_blank" rel="nofollow">x</a>', 1, '<a>'), '<a href="{{data:u}}" target="_blank" rel="nofollow noopener">x</a>');
  assert.equal(await reason('link-target-blank-rel', '<a href="/x" target="_blank" rel="noreferrer">x</a>', 1, '<a>'), 'ALREADY_SAFE');
  assert.equal(await reason('link-target-blank-rel', '<a href="/x" target="_blank" rel="{{ r }}">x</a>', 1, '<a>'), 'DYNAMIC_REL');
  assert.equal(await out('autocomplete-valid', '<input type="text" name="last_name">', 1, '<input>'), '<input type="text" name="last_name" autocomplete="family-name">');
  assert.equal(await reason('autocomplete-valid', '<input type="password" name="pw">', 1, '<input>'), 'TYPE_NOT_SUPPORTED');
  assert.equal(await reason('autocomplete-valid', '<input type="text" name="q">', 1, '<input>'), 'PURPOSE_NOT_DERIVABLE');
});

test('recipes: duplicate ids only in a single loop with in-loop references', async () => {
  const loop = '{% for a in xs %}\n<button aria-controls="p">x</button>\n<div id="p"></div>\n{% endfor %}';
  assert.equal(await out('duplicate-id', loop, 3, '<div>'), '{% for a in xs %}\n<button aria-controls="p-{{ forloop.index }}">x</button>\n<div id="p-{{ forloop.index }}"></div>\n{% endfor %}');
  assert.equal(await reason('duplicate-id', '<div id="p"></div>', 1, '<div>'), 'NOT_IN_LOOP');
  assert.equal(await reason('duplicate-id', `{% for a in xs %}{% for b in ys %}\n<div id="p"></div>\n{% endfor %}{% endfor %}`, 2, '<div>'), 'NESTED_LOOP');
  assert.equal(await reason('duplicate-id', `${loop}\n<a href="#p">jump</a>`, 3, '<div>'), 'ID_REFERENCED_OUTSIDE_LOOP');
  assert.equal(await reason('duplicate-id', '{% for a in xs %}\n<div id="p-{{ a }}"></div>\n{% endfor %}', 2, '<div>'), 'DYNAMIC_OR_ODD_ID');
});

test('recipes honour the task allowlist', async () => {
  const [t, c] = inline('meta-viewport', '<p></p>\n<meta name="viewport" content="a, user-scalable=no">', 2, '<meta>');
  assert.equal((await recipes.propose({ ...t, allowlist: [{ file: 'a.liquid', startLine: 2, endLine: 2 }] }, c)).files.length, 1);
  assert.equal((await recipes.propose({ ...t, allowlist: [{ file: 'a.liquid', startLine: 1, endLine: 1 }] }, c)).declined, 'OUTSIDE_ALLOWLIST');
  assert.equal((await recipes.propose({ ...t, allowlist: [{ file: 'b.liquid' }] }, c)).declined, 'OUTSIDE_ALLOWLIST');
});

// ------------------------------------------------------------------ CIS against a mock server on 127.0.0.1

/** Mock CIS predictions endpoint. respond({ model, messages, prompt }) -> { status?, delayMs?, content?, raw? } */
async function mockCis(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const env = JSON.parse(body || '{}');
      const messages = env.task?.input?.messages || [];
      const prompt = JSON.parse(messages.find((m) => m.role === 'user' && m.content.startsWith('{'))?.content || '{}');
      seen.push({ model: env.target?.model, messages, prompt, key: req.headers['wd-pca-feature-key'], url: req.url });
      const r = await respond({ model: env.target?.model, messages, prompt });
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.status >= 400 ? { error: { message: 'model not found' } } : { prediction: { type: 'openai-chat-completion-v1', output: { id: 'x', object: 'chat.completion', model: env.target?.model, choices: [{ index: 0, message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } } }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const baseUrl = `http://127.0.0.1:${server.address().port}/ml/inference/cis/`;
  return { seen, baseUrl, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }) };
}
const transportFor = (baseUrl, extra = {}) => createCisTransport({ baseUrl, featureKey: 'unit-test-key-not-real', allowedHosts: ['127.0.0.1'], allowInsecureLoopback: true, timeoutMs: 1500, ...extra });
const patch = ({ prompt }, oldText, newText, over = {}) => JSON.stringify({ action: 'propose_patch', edits: [{ blockId: prompt.blocks[0].blockId, expectedSha256: prompt.blocks[0].sha256, oldText, newText }], resolvesFindingIds: prompt.fixUnit.findingIds, rationale: 'Name the control.', manualChecks: ['Read the name with a screen reader.'], ...over });

const [navSite, navDefect] = defect('orchard-button-name');
const navTask = taskFor(navSite, navDefect);
const navCtx = () => contextFor(join(CORPUS_DIR, navSite.dir), navSite, navTask);
const OLD = 'aria-expanded="false"><span aria-hidden="true">Menu';
const run = async (respond, { transport, ctx = navCtx(), task = navTask } = {}) => {
  const mock = await mockCis(respond);
  try {
    const fixer = createCisFixer({ transport: transport?.(mock.baseUrl) || transportFor(mock.baseUrl), model: 'good-model' });
    return { r: await fixer.propose(task, ctx), mock };
  } finally { await mock.close(); }
};

test('cis: a valid edit becomes a candidate inside the allowlist; the prompt carries no path and no key', async () => {
  const { r, mock } = await run((q) => ({ content: patch(q, OLD, 'aria-expanded="false" aria-label="Menu"><span aria-hidden="true">Menu') }));
  assert.ok(!r.declined, r.declined);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, navDefect.file);
  assert.equal(r.files[0].after, expectedAfter(navSite, navDefect)[navDefect.file]);
  assert.equal(mock.seen.length, 1);
  assert.equal(mock.seen[0].model, 'good-model');
  const wire = JSON.stringify(mock.seen[0].messages);
  assert.ok(!/src\/partials/.test(wire), 'no source path in the prompt');
  assert.ok(!wire.includes('unit-test-key-not-real'));
  assert.equal(mock.seen[0].key, 'unit-test-key-not-real');
});

test('cis: script and URL injection is rejected before it can become a candidate', async () => {
  for (const bad of ['aria-label="Menu" onerror="alert(1)"', 'href="javascript:alert(1)"', '><script>alert(1)</script', '><iframe srcdoc="x"></iframe', 'src="data:text/html,x"']) {
    const { r } = await run((q) => ({ content: patch(q, OLD, `aria-expanded="false" ${bad}><span aria-hidden="true">Menu`) }));
    assert.equal(r.declined, 'INJECTION_REJECTED', bad);
  }
  assert.equal(injectionIn('<a onclick="x()">', '<a onclick="x()" class="y">'), null, 'pre-existing handlers are not new injection');
  assert.ok(injectionIn('<a>', '<a onclick="x()">'));
  const { r } = await run((q) => ({ content: patch(q, OLD, 'aria-label="see https://evil.example/x"><span aria-hidden="true">Menu') }));
  assert.equal(r.declined, 'PARSER_FORBIDDEN_URL');
});

test('cis: parser refusals return a reason, not a candidate', async () => {
  const cases = [
    ['PARSER_HASH_MISMATCH', (q) => patch(q, OLD, 'x', { edits: [{ blockId: q.prompt.blocks[0].blockId, expectedSha256: `sha256:${'0'.repeat(64)}`, oldText: OLD, newText: 'x' }] })],
    ['PARSER_OUTPUT_TOO_LARGE', (q) => patch(q, OLD, `aria-label="${'a'.repeat(9000)}"`)],
    ['PARSER_INVALID_JSON', () => 'not json at all'],
    ['MANUAL_CHECKS_REQUIRED', (q) => patch(q, OLD, 'aria-expanded="false" aria-label="Menu"><span aria-hidden="true">Menu', { manualChecks: [] })],
    ['STOP', () => JSON.stringify({ action: 'cannot_fix', reasonCode: 'STOP', explanation: 'needs a human label' })],
  ];
  for (const [code, mk] of cases) {
    const { r } = await run((q) => ({ content: mk(q) }));
    assert.equal(r.declined, code, code);
  }
});

test('cis: oversize response, wrong model and timeout decline through the transport limits', async () => {
  let r = (await run(() => ({ raw: JSON.stringify({ pad: 'x'.repeat(4000) }) }), { transport: (u) => transportFor(u, { maxResponseBytes: 1024 }) })).r;
  assert.equal(r.declined, 'TRANSPORT_FAILED', 'oversize');
  r = (await run((q) => (q.model === 'good-model' ? { status: 404 } : { content: '{}' }))).r;
  assert.equal(r.declined, 'TRANSPORT_FAILED', 'wrong model: HTTP error');
  const t0 = Date.now();
  r = (await run(() => ({ delayMs: 600, content: '{}' }), { transport: (u) => transportFor(u, { timeoutMs: 120 }) })).r;
  assert.equal(r.declined, 'TRANSPORT_FAILED', 'timeout');
  assert.ok(Date.now() - t0 < 1500);
});

test('cis: design-locked rules never reach the endpoint; repair prompt carries path-free failed-gate evidence', async () => {
  const [ws, wd] = defect('willow-contrast'); const wt = taskFor(ws, wd);
  const mock0 = await mockCis(() => ({ content: '{}' }));
  const locked = await createCisFixer({ transport: transportFor(mock0.baseUrl), model: 'good-model' }).propose(wt, contextFor(join(CORPUS_DIR, ws.dir), ws, wt));
  await mock0.close();
  assert.equal(locked.declined, 'DESIGN_LOCKED'); assert.equal(mock0.seen.length, 0);
  const gateEvidence = [{ gate: 'G3', pass: false, evidence: [{ kind: 'ELEMENT_MOVED', key: 'html > body > header', file: 'src/partials/header.liquid', dy: 12 }] }, { gate: 'G2', pass: true, evidence: [] }];
  const { r, mock } = await run((q) => ({ content: patch(q, OLD, 'aria-expanded="false" aria-label="Menu"><span aria-hidden="true">Menu') }), { ctx: { ...navCtx(), gateEvidence } });
  assert.ok(!r.declined);
  const wire = JSON.stringify(mock.seen[0].messages);
  assert.ok(wire.includes('failed gate G3') && wire.includes('ELEMENT_MOVED'));
  assert.ok(!wire.includes('src/partials/header.liquid'));
  assert.deepEqual(summarizeGateEvidence([{ gate: 'G4', pass: true, evidence: [] }]), []);
});

test('cis: gate evidence from the runner (null first, entries without pass, boxes, tokens) reaches CIS as actionable path-free text', () => {
  assert.deepEqual(summarizeGateEvidence(null), []);
  assert.deepEqual(summarizeGateEvidence(undefined), []);
  const s = summarizeGateEvidence([
    { gate: 'G3', evidence: [{ kind: 'MOVED', key: 'html > body > header', before: { x: 0, y: 10, w: 100, h: 20 }, after: { x: 0, y: 30, w: 100, h: 20 } }] },
    { gate: 'G2', evidence: [{ kind: 'DESIGN_TOKEN_ADDED_OR_EDITED', token: '--focus-ring: #f00' }, { kind: 'LINES_NOT_ALLOWLISTED', file: 'src/styles/a.css', hunk: 'x' }] },
  ]);
  assert.equal(s.length, 3);
  assert.ok(s[0].includes('gate G3') && s[0].includes('MOVED') && s[0].includes('after=0,30 100x20') && s[0].includes('visually hidden'));
  assert.ok(s[1].includes('--focus-ring') && s[1].includes('add no colour'));
  assert.ok(!s.join(' ').includes('src/styles'));
});

test('cis: a first attempt with null gate evidence proposes (it used to end CIS_FIXER_ERROR)', async () => {
  const { r } = await run((q) => ({ content: patch(q, OLD, 'aria-expanded="false" aria-label="Menu"><span aria-hidden="true">Menu') }), { ctx: { ...navCtx(), previous: null, gateEvidence: null } });
  assert.ok(!r.declined && r.files?.length);
});

// ------------------------------------------------------------------ external tool diff

const EXT_TASK = { rule: 'button-name', allowlist: [{ file: 'src/partials/header.liquid', startLine: 2, endLine: 4 }] };
const baseText = readFileSync(join(CORPUS_DIR, navSite.dir, navDefect.file), 'utf8');
const exp = expectedAfter(navSite, navDefect)[navDefect.file];
const ctxFor = (text = baseText) => ({ files: { [navDefect.file]: { text } } });
const diffOf = (path, a, b) => {
  const d = mkdtempSync(join(work, 'd-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: d, encoding: 'utf8' });
  mkdirSync(join(d, path, '..'), { recursive: true });
  writeFileSync(join(d, path), a); git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  writeFileSync(join(d, path), b);
  return git('diff', '--no-color', '--no-ext-diff', '-U1');
};

test('external: a unified diff becomes the same candidate format', async () => {
  const diff = diffOf(navDefect.file, baseText, exp);
  assert.ok(parseUnifiedDiff(diff).files.length === 1);
  const r = await createExternalFixer({ diff, name: 'agent' }).propose(EXT_TASK, ctxFor());
  assert.ok(!r.declined, r.declined);
  assert.deepEqual(r.files, [{ path: navDefect.file, before: baseText, after: exp }]);
});

test('external: fail closed on out-of-allowlist, traversal, binary, mode, renames and stale hunks', async () => {
  const diff = diffOf(navDefect.file, baseText, exp);
  const prop = (s, task = EXT_TASK, ctx = ctxFor()) => createExternalFixer(s).propose(task, ctx);
  assert.equal((await prop({ diff }, { ...EXT_TASK, allowlist: [{ file: 'src/partials/header.liquid', startLine: 9, endLine: 9 }] })).declined, 'OUTSIDE_ALLOWLIST');
  assert.equal((await prop({ diff }, { ...EXT_TASK, allowlist: [{ file: 'other.liquid' }] })).declined, 'OUTSIDE_ALLOWLIST');
  assert.equal((await prop({ diff: diff.replace(new RegExp(navDefect.file.replace(/\//g, '\\/'), 'g'), '../../etc/passwd') })).declined, 'PATH_REJECTED');
  assert.equal((await prop({ diff: 'diff --git a/x b/x\nGIT binary patch\nliteral 1\n' })).declined, 'BINARY_CHANGE');
  assert.equal((await prop({ diff: 'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n' })).declined, 'MODE_OR_RENAME_CHANGE');
  assert.equal((await prop({ diff: 'diff --git a/x b/y\nrename from x\nrename to y\n' })).declined, 'MODE_OR_RENAME_CHANGE');
  assert.equal((await prop({ diff }, EXT_TASK, ctxFor(`${baseText}\nchanged`.replace('Menu', 'Other')))).declined, 'HUNK_DOES_NOT_APPLY');
  assert.equal((await prop({ diff: '' })).declined, 'EMPTY_DIFF');
  assert.equal((await prop({})).declined, 'NO_DIFF_SOURCE');
});

test('external: two directory trees and a git working tree give the same candidate; new and deleted files are reported', async () => {
  const base = copy(navSite); const tool = copy(navSite);
  writeFileSync(join(tool, navDefect.file), exp);
  let r = await createExternalFixer({ dir: tool, baseDir: base }).propose(EXT_TASK, { files: {} });
  assert.deepEqual(r.files, [{ path: navDefect.file, before: baseText, after: exp }]);
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { cwd: base, encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  writeFileSync(join(base, navDefect.file), exp);
  r = await createExternalFixer({ dir: base }).propose(EXT_TASK, { files: {} });
  assert.deepEqual(r.files, [{ path: navDefect.file, before: baseText, after: exp }]);
  writeFileSync(join(tool, 'src/partials/new.liquid'), 'x\n');
  r = await createExternalFixer({ dir: tool, baseDir: copy(navSite) }).propose({ ...EXT_TASK, allowlist: [{ file: navDefect.file }] }, { files: {} });
  assert.equal(r.declined, 'OUTSIDE_ALLOWLIST');
  r = await createExternalFixer({ dir: tool, baseDir: copy(navSite) }).propose({ ...EXT_TASK, allowlist: [{ file: navDefect.file }, { file: 'src/partials/new.liquid' }] }, { files: {} });
  assert.deepEqual(r.files.map((f) => [f.path, f.before]), [[navDefect.file, baseText], ['src/partials/new.liquid', null]]);
});

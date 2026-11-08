import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startParadoxSite, PARADOX_SITE_DIR } from './helpers/paradox-site-server.js';
import { runGolden, diffFindings } from '../scripts/golden/run.js';

const quiet = () => {};

test('fixture server serves extensionless routes, 404 page, and strips snippet markers for studio', async () => {
  const local = await startParadoxSite();
  const studio = await startParadoxSite({ variant: 'studio' });
  try {
    const home = await fetch(`${local.url}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<!-- snippets\/header\.html -->/);
    assert.equal((await fetch(`${local.url}/benefits`)).status, 200);
    const missing = await fetch(`${local.url}/nope`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Page not found/);
    assert.doesNotMatch(await (await fetch(`${studio.url}/jobs`)).text(), /snippets\//);
  } finally {
    await local.close();
    await studio.close();
  }
});

test('diffFindings reports missing, new and changed keys', () => {
  const diff = diffFindings({ a: { n: 1 }, b: { n: 1 } }, { a: { n: 2 }, c: { n: 1 } });
  assert.equal(diff.length, 3);
});

test('golden runner passes on the committed golden', { timeout: 400_000 }, async () => {
  const result = await runGolden({ log: quiet });
  assert.deepEqual(result.diff, []);
  assert.equal(result.ok, true);
});

test('golden runner fails when a seeded defect is removed', { timeout: 400_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ada-golden-site-'));
  try {
    await cp(PARADOX_SITE_DIR, dir, { recursive: true });
    const index = path.join(dir, 'index.html');
    const html = await readFile(index, 'utf8');
    await writeFile(index, html.replace('<img class="defect-img" src="/pixel.svg" width="40" height="40">', '<img class="defect-img" src="/pixel.svg" width="40" height="40" alt="Acme">'));
    const result = await runGolden({ siteDir: dir, log: quiet });
    assert.equal(result.ok, false);
    assert.ok(result.diff.some((line) => line.includes('axe:image-alt|.defect-img|/')), result.diff.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

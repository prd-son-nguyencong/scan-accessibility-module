import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getProjectRoot,
  resetProjectRootCache,
  distToSrcLiquid,
  urlToPageFile,
} from '../src/utils/paths.js';

function tmp() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-scan-')));
}

test('ADA_SCAN_ROOT overrides everything', () => {
  const dir = tmp();
  const prev = process.env.ADA_SCAN_ROOT;
  process.env.ADA_SCAN_ROOT = dir;
  resetProjectRootCache();
  try {
    assert.equal(getProjectRoot(), dir);
  } finally {
    if (prev === undefined) delete process.env.ADA_SCAN_ROOT;
    else process.env.ADA_SCAN_ROOT = prev;
    resetProjectRootCache();
  }
});

test('walks up to the nearest .scan-config.json', () => {
  const root = tmp();
  writeFileSync(path.join(root, '.scan-config.json'), '{}');
  const nested = path.join(root, 'a', 'b');
  mkdirSync(nested, { recursive: true });

  const prevCwd = process.cwd();
  const prevEnv = process.env.ADA_SCAN_ROOT;
  delete process.env.ADA_SCAN_ROOT;
  process.chdir(nested);
  resetProjectRootCache();
  try {
    assert.equal(getProjectRoot(), root);
  } finally {
    process.chdir(prevCwd);
    if (prevEnv !== undefined) process.env.ADA_SCAN_ROOT = prevEnv;
    resetProjectRootCache();
  }
});

test('falls back to nearest package.json when no config exists', () => {
  const root = tmp();
  writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  const nested = path.join(root, 'sub');
  mkdirSync(nested, { recursive: true });

  const prevCwd = process.cwd();
  const prevEnv = process.env.ADA_SCAN_ROOT;
  delete process.env.ADA_SCAN_ROOT;
  process.chdir(nested);
  resetProjectRootCache();
  try {
    assert.equal(getProjectRoot(), root);
  } finally {
    process.chdir(prevCwd);
    if (prevEnv !== undefined) process.env.ADA_SCAN_ROOT = prevEnv;
    resetProjectRootCache();
  }
});

test('distToSrcLiquid honors distMap and default fallback', () => {
  assert.equal(distToSrcLiquid('dist/partials/layout/header.html'), 'src/partials/layout/header.liquid');
  assert.equal(
    distToSrcLiquid('build/views/home.html', [{ dist: 'build/views/', src: 'app/views/', ext: '.njk' }]),
    'app/views/home.njk'
  );
  assert.equal(distToSrcLiquid('dist/unmapped/x.html'), 'src/unmapped/x.liquid');
});

test('urlToPageFile honors source opts', () => {
  assert.equal(urlToPageFile('/'), 'src/pages/index.liquid');
  assert.equal(urlToPageFile('/jobs/detail'), 'src/pages/jobs/detail.liquid');
  assert.equal(
    urlToPageFile('/about', { pagesRoot: 'app/routes', extension: '.vue' }),
    'app/routes/about.vue'
  );
});

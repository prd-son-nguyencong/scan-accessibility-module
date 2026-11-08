import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeTraceRoot, printTraceRoot } from '../src/scanner/scan-hygiene.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ada-hyg-'));

test('a git project that names the URL port: root, branch and short commit are printed and nothing warns', () => {
  const root = tmp();
  try {
    writeFileSync(path.join(root, 'package.json'), '{"scripts":{"dev":"vite --port 1234"}}');
    const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    g('init', '-b', 'feature-x'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'x');
    const lines = [];
    const d = printTraceRoot({ root, cwd: root, url: 'http://localhost:1234/' }, (l) => lines.push(l));
    assert.deepEqual(d.warnings, []);
    assert.equal(d.branch, 'feature-x');
    assert.match(d.commit, /^[0-9a-f]{7,}$/);
    assert.match(lines[0], new RegExp(`Tracing against: .*${path.basename(root)} \\(branch feature-x, commit ${d.commit}\\)`));
    assert.equal(lines.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('warns loudly: root that is not a project, cwd outside the root, and a local URL port the root never names', () => {
  const root = tmp(); const other = tmp();
  try {
    const bare = describeTraceRoot({ root, cwd: other, url: 'http://127.0.0.1:5173/' });
    assert.equal(bare.warnings.length, 3);
    assert.match(bare.warnings[0], /is not a project/);
    assert.match(bare.warnings[1], /outside the trace root/);
    assert.match(bare.warnings[2], /port 5173/);
    assert.equal(bare.branch, null);
    const lines = [];
    printTraceRoot({ root, cwd: other, url: 'http://127.0.0.1:5173/' }, (l) => lines.push(l));
    assert.equal(lines.filter((l) => l.includes('!!! WARNING')).length, 3);
    // the same project once it names the port (and a port that merely contains the digits does not count)
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'vite.config.js'), 'export default { server: { port: 51730 } }');
    assert.match(describeTraceRoot({ root, cwd: root, url: 'http://127.0.0.1:5173/' }).warnings.join(), /port 5173/);
    writeFileSync(path.join(root, 'vite.config.js'), 'export default { server: { port: 5173 } }');
    assert.deepEqual(describeTraceRoot({ root, cwd: root, url: 'http://127.0.0.1:5173/' }).warnings, []);
    // no URL (remote or plain local scan): the dev-server check does not apply
    assert.deepEqual(describeTraceRoot({ root, cwd: root }).warnings, []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

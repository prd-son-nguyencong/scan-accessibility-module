import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requireBrowser } from './helpers/require-browser.js';
import { closeBrowser, timedRefreshTarget } from '../src/scanner/browser.js';
import { scanOnePage } from '../src/index.js';
import { buildReportBundle } from '../src/reporter/scan-report.js';
import { DEFAULT_CONFIG, mergeConfig } from '../src/utils/config.js';

after(() => closeBrowser());

const page = (head) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Seed</title>${head}<meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><p>Fill in the form.</p></main></body></html>`;

test('timedRefreshTarget: timed refreshes resolve to a URL; immediate redirects, self refreshes and plain pages do not', () => {
  const base = 'http://x.test/a/page.html';
  const meta = (c) => page(`<meta http-equiv="refresh" content="${c}">`);
  assert.equal(timedRefreshTarget(meta('3; url=/next'), {}, base), 'http://x.test/next');
  assert.equal(timedRefreshTarget(meta('5;URL=\'next.html\''), {}, base), 'http://x.test/a/next.html');
  assert.equal(timedRefreshTarget(page('<meta content="10, /next" HTTP-EQUIV=Refresh>'), {}, base), 'http://x.test/next');
  assert.equal(timedRefreshTarget(meta('3; url=/next#top'), {}, base), 'http://x.test/next', 'a fragment is stripped: the request URL never carries one');
  assert.equal(timedRefreshTarget(meta('3; url=/a/page.html#top'), {}, base + '#x'), null, 'a refresh to the page itself, fragment aside');
  assert.equal(timedRefreshTarget(page(''), { refresh: '4; url=/hdr' }, base), 'http://x.test/hdr');
  assert.equal(timedRefreshTarget(meta('0; url=/next'), {}, base), null);
  assert.equal(timedRefreshTarget(meta('30'), {}, base), null);
  assert.equal(timedRefreshTarget(meta('30; url=page.html'), {}, base), null);
  assert.equal(timedRefreshTarget(page('<meta name="description" content="3; url=/next">'), {}, base), null);
});

// The reviewer's reproduction: Chromium followed a 3s or 5s refresh mid-scan, the report lost its MetaRefresh finding and carried the next page's findings.
test('a 3s, a 5s and a 3s-with-fragment meta refresh do not move the scan: no request for the target, MetaRefresh confirmed on the requested URL', async (t) => {
  if (!await requireBrowser(t)) return;
  const pages = { '/refresh3.html': page('<meta http-equiv="refresh" content="3; url=/next">'), '/refresh5.html': page('<meta http-equiv="refresh" content="5; url=/next">'), '/frag.html': page('<meta http-equiv="refresh" content="3; url=/next#top">'), '/next': '<!doctype html><html lang="en"><head><title>Next</title></head><body><h1>Next</h1></body></html>' };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (!pages[req.url]) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(pages[req.url]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = mergeConfig(DEFAULT_CONFIG, { layers: { w3c: false, links: false, lighthouse: false } });
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    for (const name of ['/refresh3.html', '/refresh5.html', '/frag.html']) {
      const pr = await scanOnePage({ name, url: origin + name }, config, { isUrlMode: true, includeThirdParty: true });
      const { report } = buildReportBundle([pr], { producer: { name: 'x', version: 'e' } });
      const findings = report.pages[0].findings;
      assert.equal(report.pages[0].url, origin + name);
      assert.ok(findings.some((f) => f.nativeRuleId === 'MetaRefresh' && f.verdict === 'confirmed'), `${name}: ${findings.map((f) => `${f.verdict} ${f.nativeRuleId}`).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // past the 5s mark of the last scan's first load
    assert.equal(seen.includes('/next'), false, `the refresh target was requested: ${seen.join(' ')}`);
  } finally {
    console.log = log; console.warn = warn;
    server.close();
  }
});

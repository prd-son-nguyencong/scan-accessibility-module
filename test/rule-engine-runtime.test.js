import { readFileSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import {
  createScanSession,
  REQUIRES_ISOLATED_STATE,
  queryGraph,
  filterByEligibility,
} from '../src/scanner/access-scan/runtime/index.js';

async function withPage(markup, run, { beforeContent } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    if (beforeContent) {
      await beforeContent(page);
    }
    await page.setContent(markup, { waitUntil: 'domcontentloaded' });
    return await run(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

function elementByLocalId(snapshot, id) {
  return snapshot.elements.find((element) => element.id === id);
}

function elementsMatchingTag(snapshot, tag) {
  return snapshot.elements.filter((element) => element.tag === tag);
}

test('createScanSession waits for delayed DOM stability before snapshot', async () => {
  await withPage(
    `
      <div id="root"></div>
      <script>
        setTimeout(() => {
          document.getElementById('root').innerHTML = '<button id="late">Late</button>';
        }, 120);
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page, {
        stabilityQuietMs: 40,
        stabilityTimeoutMs: 4000,
      });
      const buttons = elementsMatchingTag(session.snapshot, 'button');
      assert.equal(buttons.length, 1);
      assert.match(buttons[0].accessibleName, /late/i);
      assert.equal(session.metrics.snapshotCount, 1);
      assert.equal(session.metrics.runtimeInstallCount, 1);
    },
  );
});

test('createScanSession traverses nested open shadow roots', async () => {
  await withPage(
    `
      <div id="host-outer"></div>
      <script>
        const outer = document.getElementById('host-outer');
        const shadowOuter = outer.attachShadow({ mode: 'open' });
        shadowOuter.innerHTML = '<div id="host-inner"></div>';
        const innerHost = shadowOuter.getElementById('host-inner');
        const shadowInner = innerHost.attachShadow({ mode: 'open' });
        shadowInner.innerHTML = '<button id="deep-btn">Deep</button>';
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const button = session.snapshot.elements.find(
        (element) => element.tag === 'button' && element.accessibleName === 'Deep',
      );
      assert.ok(button, 'expected deep shadow button in snapshot');
      assert.deepEqual(button.shadowPath, [0, 0]);
      assert.ok(button.reportSelector.includes('shadow'));
      assert.ok(button.selector.length > 0);
    },
  );
});

test('createScanSession traverses same-origin srcdoc iframe documents', async () => {
  await withPage(
    `
      <iframe
        id="doc-frame"
        srcdoc="<main><p id='in-frame'>Inside frame</p><button>Frame action</button></main>"
      ></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const inFrame = session.snapshot.elements.find(
        (element) => element.tag === 'p' && element.text.includes('Inside frame'),
      );
      assert.ok(inFrame, 'expected srcdoc iframe paragraph');
      assert.deepEqual(inFrame.framePath, [0]);
      const frameButton = session.snapshot.elements.find(
        (element) => element.tag === 'button' && element.accessibleName === 'Frame action',
      );
      assert.ok(frameButton);
      assert.deepEqual(frameButton.framePath, [0]);
    },
  );
});

test('createScanSession reports sandbox frame diagnostics without claiming inspection', async () => {
  await withPage(
    `
      <iframe id="sandboxed" sandbox src="about:blank"></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const sandboxDiag = session.diagnostics.find(
        (entry) => entry.code === 'frame-inaccessible' && entry.reason === 'sandbox',
      );
      assert.ok(sandboxDiag, 'expected sandbox frame diagnostic');
      assert.equal(sandboxDiag.inspected, false);
    },
  );
});

test('createScanSession reports cross-origin frame diagnostics', async () => {
  await withPage(
    `
      <iframe id="remote" src="https://example.com/"></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const crossOriginDiag = session.diagnostics.find(
        (entry) => entry.code === 'frame-inaccessible' && entry.reason === 'cross-origin',
      );
      assert.ok(crossOriginDiag, 'expected cross-origin frame diagnostic');
      assert.equal(crossOriginDiag.inspected, false);
    },
  );
});

test('createScanSession reports closed shadow root diagnostics from init hook', async () => {
  await withPage(
    `
      <div id="closed-host"></div>
      <script>
        document.getElementById('closed-host').attachShadow({ mode: 'closed' });
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const closedDiag = session.diagnostics.find(
        (entry) => entry.code === 'shadow-root-closed',
      );
      assert.ok(closedDiag, 'expected closed shadow diagnostic');
      assert.equal(closedDiag.inspected, false);
      assert.equal(
        session.snapshot.elements.some((element) => element.tag === 'button'),
        false,
      );
    },
    {
      async beforeContent(page) {
        const { installRuntimeHooks } = await import(
          '../src/scanner/access-scan/runtime/session.js'
        );
        await installRuntimeHooks(page);
      },
    },
  );
});

test('createScanSession reports observation-incomplete when hook attaches after content', async () => {
  await withPage(
    `
      <div id="closed-host"></div>
      <script>
        document.getElementById('closed-host').attachShadow({ mode: 'closed' });
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const incompleteDiag = session.diagnostics.find(
        (entry) => entry.code === 'shadow-root-observation-incomplete',
      );
      assert.ok(incompleteDiag, 'expected honest coverage diagnostic when hook missed');
      assert.equal(incompleteDiag.inspected, false);
      assert.equal(incompleteDiag.details, undefined);
      assert.equal(
        session.diagnostics.some((entry) => entry.code === 'shadow-root-closed'),
        false,
      );
    },
  );
});

test('visibility matrix distinguishes rendered, visually visible, and AT-hidden states', async () => {
  await withPage(
    `
      <style>
        #opacity-zero { opacity: 0; width: 40px; height: 20px; display: block; }
        #offscreen { position: absolute; left: -9999px; width: 40px; height: 20px; }
        #display-none { display: none; }
        #visibility-hidden { visibility: hidden; width: 40px; height: 20px; }
        #aria-hidden-true { width: 40px; height: 20px; }
      </style>
      <button id="opacity-zero">Opacity zero</button>
      <button id="offscreen">Offscreen</button>
      <button id="display-none">Display none</button>
      <button id="visibility-hidden">Visibility hidden</button>
      <button id="aria-hidden-true" aria-hidden="true">Aria hidden</button>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const byId = Object.fromEntries(
        session.snapshot.elements
          .filter((element) => element.tag === 'button')
          .map((element) => [element.attributes.id, element]),
      );

      assert.equal(byId['opacity-zero'].rendered, true);
      assert.equal(byId['opacity-zero'].visuallyVisible, false);

      assert.equal(byId.offscreen.rendered, true);
      assert.equal(byId.offscreen.visuallyVisible, false);

      assert.equal(byId['display-none'].rendered, false);
      assert.equal(byId['display-none'].visuallyVisible, false);

      assert.equal(byId['visibility-hidden'].rendered, false);
      assert.equal(byId['visibility-hidden'].visuallyVisible, false);

      assert.equal(byId['aria-hidden-true'].rendered, true);
      assert.equal(byId['aria-hidden-true'].hiddenFromAT, true);
      assert.equal(byId['aria-hidden-true'].focusable, false);
    },
  );
});

test('accessible name helper resolves labelledby, labels, values, and cycles safely', async () => {
  await withPage(
    `
      <span id="a">Alpha</span>
      <span id="b">Beta</span>
      <button id="joined" aria-labelledby="a b">Ignored</button>
      <label for="email">Email</label>
      <input id="email" type="email" />
      <label>Password <input id="password" type="password" value="secret" /></label>
      <button id="value-btn" value="Save draft">Save draft</button>
      <img id="logo" src="logo.svg" alt="Company logo" />
      <button id="cycle-a" aria-labelledby="cycle-b"></button>
      <button id="cycle-b" aria-labelledby="cycle-a"></button>
      <button id="missing-ref" aria-labelledby="does-not-exist">Visible</button>
      <button id="title-only" title="Tooltip title">X</button>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const byId = Object.fromEntries(
        session.snapshot.elements
          .filter((element) => element.attributes.id)
          .map((element) => [element.attributes.id, element]),
      );

      assert.equal(byId.joined.accessibleName, 'Alpha Beta');
      assert.equal(byId.email.accessibleName, 'Email');
      assert.match(byId.password.accessibleName, /password/i);
      assert.equal(byId['value-btn'].accessibleName, 'Save draft');
      assert.equal(byId.logo.accessibleName, 'Company logo');
      assert.equal(byId['cycle-a'].accessibleName, '');
      assert.equal(byId['missing-ref'].accessibleName, 'Visible');
      assert.equal(byId['title-only'].accessibleName, 'X');
    },
  );
});

test('selector generation handles duplicate and special IDs with separate report paths', async () => {
  await withPage(
    `
      <div id="dup"></div>
      <div id="dup"></div>
      <div id="weird:id"></div>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const dupes = session.snapshot.elements.filter(
        (element) => element.attributes.id === 'dup',
      );
      assert.equal(dupes.length, 2);
      assert.notEqual(dupes[0].selector, dupes[1].selector);
      assert.notEqual(dupes[0].reportSelector, dupes[1].reportSelector);

      const weird = session.snapshot.elements.find(
        (element) => element.attributes.id === 'weird:id',
      );
      assert.ok(weird);
      assert.match(weird.selector, /weird/);
      assert.ok(weird.reportSelector.length > weird.selector.length);
    },
  );
});

test('snapshot redacts sensitive values and token-like attributes', async () => {
  await withPage(
    `
      <input id="pw" type="password" value="super-secret" />
      <input id="hidden" type="hidden" value="csrf-token-value" />
      <input id="token" data-token="abc123" value="plain" />
      <meta name="csrf-token" content="meta-secret" />
    `,
    async (page) => {
      const session = await createScanSession(page);
      const password = session.snapshot.elements.find(
        (element) => element.attributes.id === 'pw',
      );
      const hidden = session.snapshot.elements.find(
        (element) => element.attributes.id === 'hidden',
      );
      const token = session.snapshot.elements.find(
        (element) => element.attributes.id === 'token',
      );
      const meta = session.snapshot.elements.find((element) => element.tag === 'meta');

      assert.match(password.outerHTML, /\[redacted\]/);
      assert.match(hidden.outerHTML, /\[redacted\]/);
      assert.equal(token.attributes['data-token'], '[redacted]');
      assert.match(meta.outerHTML, /\[redacted\]/);
    },
  );
});

test('createScanSession caches immutable snapshot and exposes metrics', async () => {
  await withPage('<button>One</button>', async (page) => {
    const session = await createScanSession(page);
    const first = session.snapshot;
    const second = await session.getSnapshot();
    assert.equal(first, second);
    assert.equal(session.metrics.snapshotCount, 1);
    assert.equal(session.metrics.elementCount, session.snapshot.elements.length);
    assert.ok(session.metrics.elementCount >= 1);
  });
});

test('createScanSession survives malformed DOM without throwing', async () => {
  await withPage(
    `
      <div id="broken">
        <p>Unclosed
        <svg><title>Icon</title></svg>
      </div>
    `,
    async (page) => {
      const session = await createScanSession(page);
      assert.ok(session.snapshot.elements.length > 0);
      assert.equal(session.metrics.snapshotCount, 1);
    },
  );
});

test('queryGraph supports basic selectors and eligibility filtering', async () => {
  await withPage(
    `
      <button id="visible">Visible</button>
      <button id="hidden" hidden>Hidden</button>
      <input id="search" type="search" role="searchbox" />
      <a href="/" role="button">Link button</a>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const buttons = queryGraph(session.snapshot, 'button');
      assert.equal(buttons.length, 2);

      const searchInputs = queryGraph(session.snapshot, 'input[type="search"]');
      assert.equal(searchInputs.length, 1);

      const roleButtons = queryGraph(session.snapshot, '[role="button"]');
      assert.equal(roleButtons.length, 1);

      const activeButtons = filterByEligibility(
        queryGraph(session.snapshot, 'button'),
        { visibility: 'active-content' },
      );
      assert.equal(activeButtons.length, 1);
      assert.equal(activeButtons[0].attributes.id, 'visible');

      const visuallyVisible = filterByEligibility(
        queryGraph(session.snapshot, 'button'),
        { visibility: 'visibility' },
      );
      assert.equal(visuallyVisible.length, 1);

      const allButtons = filterByEligibility(
        queryGraph(session.snapshot, 'button'),
        { visibility: 'all' },
      );
      assert.equal(allButtons.length, 2);
    },
  );
});

test('queryGraph returns diagnostics for unsupported selectors', async () => {
  await withPage('<div><span>child</span></div>', async (page) => {
    const session = await createScanSession(page);
    const result = queryGraph(session.snapshot, 'div > span', { diagnostics: [] });
    assert.equal(result.matches.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'selector-unsupported');
    assert.match(result.diagnostics[0].selector, /div > span/);
  });
});

test('behavioral fork installs runtime, reproduces source, and returns scanSession', async () => {
  await withPage('<button id="action">Action</button>', async (page) => {
    const session = await createScanSession(page);
    assert.equal(session.requiresIsolatedState, true);
    assert.equal(REQUIRES_ISOLATED_STATE, true);

    const fork = await session.forkBehavioralPage();
    assert.ok(fork.page);
    assert.equal(fork.requiresIsolatedState, true);
    assert.notEqual(fork.page, page);
    assert.ok(fork.scanSession);
    assert.equal(fork.scanSession.metrics.snapshotCount, 1);
    assert.ok(
      await fork.page.evaluate(() => Boolean(globalThis.__adaScanRuntime)),
    );
    assert.ok(
      fork.scanSession.snapshot.elements.some(
        (element) => element.attributes.id === 'action',
      ),
    );
    assert.equal(typeof fork.cleanup, 'function');
    await fork.cleanup();
  });
});

test('snapshot is deeply frozen and rejects nested mutation', async () => {
  await withPage('<button id="freeze-me">Freeze</button>', async (page) => {
    const session = await createScanSession(page);
    const element = session.snapshot.elements.find(
      (entry) => entry.attributes.id === 'freeze-me',
    );
    assert.ok(element);

    assert.throws(() => {
      element.attributes.id = 'mutated';
    });
    assert.throws(() => {
      element.rect.width = 0;
    });
    assert.throws(() => {
      element.framePath.push(99);
    });
    assert.throws(() => {
      session.snapshot.counts.frameCount = 99;
    });

    const diag = session.snapshot.diagnostics.find(
      (entry) => entry.code === 'frame-inaccessible',
    );
    if (diag?.details) {
      assert.throws(() => {
        diag.details.framePath = [];
      });
    }

    assert.equal(element.attributes.id, 'freeze-me');
    assert.equal(element.rect.width > 0, true);
  });
});

test('structural snippets are bounded and omit nested subtree cloning', async () => {
  await withPage(
    `
      <div id="wrapper" class="outer">
        <span>visible</span>
        <div id="nested-secret">deep-secret-text-should-not-appear-fully</div>
        <script>const secret = "leak";</script>
      </div>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const wrapper = session.snapshot.elements.find(
        (entry) => entry.attributes.id === 'wrapper',
      );
      assert.ok(wrapper);
      assert.ok(wrapper.outerHTML.length <= 500);
      assert.match(wrapper.outerHTML, /^<div/);
      assert.match(wrapper.outerHTML, /visible/);
      assert.doesNotMatch(wrapper.outerHTML, /deep-secret-text-should-not-appear-fully/);
      assert.match(wrapper.outerHTML, /<script>\[omitted\]<\/script>/);
    },
  );
});

test('decorative alt="" terminates accessible name as empty', async () => {
  await withPage('<img id="decorative" src="x.svg" alt="">', async (page) => {
    const session = await createScanSession(page);
    const img = session.snapshot.elements.find(
      (entry) => entry.attributes.id === 'decorative',
    );
    assert.equal(img.accessibleName, '');
  });
});

test('accessible name uses AT-exposed text independent of viewport visibility', async () => {
  await withPage(
    `
      <style>#offscreen-name { position: absolute; left: -9999px; }</style>
      <button id="offscreen-name"><span>Offscreen label</span></button>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const button = session.snapshot.elements.find(
        (entry) => entry.attributes.id === 'offscreen-name',
      );
      assert.equal(button.visuallyVisible, false);
      assert.equal(button.accessibleName, 'Offscreen label');
    },
  );
});

test('aria-labelledby does not resolve IDREF across frame boundaries', async () => {
  await withPage(
    `
      <span id="shared">Parent Label</span>
      <iframe srcdoc="<button aria-labelledby='shared'>Frame Btn</button>"></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const frameButton = session.snapshot.elements.find(
        (entry) => entry.tag === 'button' && entry.framePath.length === 1,
      );
      assert.ok(frameButton);
      assert.equal(frameButton.accessibleName, 'Frame Btn');
      assert.notEqual(frameButton.accessibleName, 'Parent Label');
    },
  );
});

test('queryGraph supports star, whitespace lists, and flexible attribute selectors', async () => {
  await withPage(
    `
      <div id="a" data-role="nav"></div>
      <input id="b" type="text" required />
      <button id="c" TYPE="submit">Go</button>
    `,
    async (page) => {
      const session = await createScanSession(page);
      assert.equal(queryGraph(session.snapshot, '*').length, session.snapshot.elements.length);
      assert.equal(queryGraph(session.snapshot, 'div, input').length, 2);
      assert.equal(queryGraph(session.snapshot, '[data-role=nav]').length, 1);
      assert.equal(queryGraph(session.snapshot, '[TYPE="submit"]').length, 1);
      assert.equal(queryGraph(session.snapshot, "input[type='text'][required]").length, 1);
    },
  );
});

test('redaction omits script text and preserves normal meta description', async () => {
  await withPage(
    `
      <meta name="description" content="Public summary" />
      <meta name="csrf-token" content="secret-token" />
      <a id="link" href="/jobs?token=abc&page=2">Jobs</a>
      <div id="holder"><script>alert('secret')</script></div>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const description = session.snapshot.elements.find(
        (entry) => entry.tag === 'meta' && entry.attributes.name === 'description',
      );
      const csrf = session.snapshot.elements.find(
        (entry) => entry.tag === 'meta' && entry.attributes.name === 'csrf-token',
      );
      const link = session.snapshot.elements.find(
        (entry) => entry.attributes.id === 'link',
      );
      const holder = session.snapshot.elements.find(
        (entry) => entry.attributes.id === 'holder',
      );

      assert.equal(description.attributes.content, 'Public summary');
      assert.equal(csrf.attributes.content, '[redacted]');
      assert.match(
        decodeURIComponent(link.attributes.href),
        /\[redacted\]/,
      );
      assert.match(link.attributes.href, /page=2/);
      assert.doesNotMatch(holder.outerHTML, /alert\('secret'\)/);
      assert.match(holder.outerHTML, /<script>\[omitted\]<\/script>/);
    },
  );
});

test('behavioral fork isolates localStorage mutations in separate BrowserContext', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<button id="iso">Iso</button>');
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const pageUrl = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('ada-scan-iso', 'source-value');
    });

    const session = await createScanSession(page);
    const fork = await session.forkBehavioralPage();
    assert.equal(fork.isolationMode, 'isolated-context');

    await fork.page.evaluate(() => {
      localStorage.setItem('ada-scan-iso', 'fork-value');
    });

    const sourceValue = await page.evaluate(() => localStorage.getItem('ada-scan-iso'));
    const forkValue = await fork.page.evaluate(() => localStorage.getItem('ada-scan-iso'));
    assert.equal(sourceValue, 'source-value');
    assert.equal(forkValue, 'fork-value');

    await fork.cleanup();
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('5k-node nested container snapshot remains bounded', async () => {
  await withPage(
    `
      <div id="bench-root"></div>
      <script>
        const root = document.getElementById('bench-root');
        let html = '';
        for (let layer = 0; layer < 50; layer += 1) {
          html += '<div class="layer-' + layer + '">';
        }
        for (let i = 0; i < 5000; i += 1) {
          html += '<span data-i="' + i + '">n' + i + '</span>';
        }
        for (let layer = 0; layer < 50; layer += 1) {
          html += '</div>';
        }
        root.innerHTML = html;
      </script>
    `,
    async (page) => {
      const startedAt = Date.now();
      const session = await createScanSession(page, {
        stabilityQuietMs: 40,
        stabilityMinObserveMs: 150,
        stabilityTimeoutMs: 8000,
      });
      const elapsed = Date.now() - startedAt;
      const budgetMs = Number(process.env.ADA_SCAN_SNAPSHOT_BUDGET_MS) || 20_000;
      assert.ok(session.snapshot.elements.length >= 5050);
      assert.ok(elapsed < budgetMs, `expected bounded 5k snapshot, took ${elapsed}ms (budget ${budgetMs}ms)`);

      const runtimeSource = readFileSync(
        new URL('../src/scanner/access-scan/runtime/runtime.browser.js', import.meta.url),
        'utf8',
      );
      assert.equal(runtimeSource.includes('cloneNode(true)'), false);
      assert.equal(runtimeSource.includes("querySelectorAll('*')"), false);
    },
  );
});

test('createScanSession waits for delayed open shadow mutations', async () => {
  await withPage(
    `
      <div id="shadow-host"></div>
      <script>
        setTimeout(() => {
          const host = document.getElementById('shadow-host');
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<button id="shadow-late">Shadow late</button>';
        }, 120);
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page, {
        stabilityQuietMs: 40,
        stabilityMinObserveMs: 150,
        stabilityTimeoutMs: 4000,
      });
      const button = session.snapshot.elements.find(
        (element) => element.attributes.id === 'shadow-late',
      );
      assert.ok(button, 'expected delayed shadow button');
      assert.deepEqual(button.shadowPath, [0]);
    },
  );
});

test('createScanSession waits for delayed same-origin frame mutations', async () => {
  await withPage(
    `
      <iframe id="late-frame" srcdoc="<main></main>"></iframe>
      <script>
        setTimeout(() => {
          const doc = document.getElementById('late-frame').contentDocument;
          doc.body.innerHTML = '<button id="frame-late">Frame late</button>';
        }, 120);
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page, {
        stabilityQuietMs: 40,
        stabilityMinObserveMs: 150,
        stabilityTimeoutMs: 4000,
      });
      const button = session.snapshot.elements.find(
        (element) => element.attributes.id === 'frame-late',
      );
      assert.ok(button, 'expected delayed frame button');
      assert.deepEqual(button.framePath, [0]);
    },
  );
});

test('framePath distinguishes sibling iframes', async () => {
  await withPage(
    `
      <iframe srcdoc="<button id='left-btn'>Left</button>"></iframe>
      <iframe srcdoc="<button id='right-btn'>Right</button>"></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const left = session.snapshot.elements.find(
        (element) => element.attributes.id === 'left-btn',
      );
      const right = session.snapshot.elements.find(
        (element) => element.attributes.id === 'right-btn',
      );
      assert.ok(left);
      assert.ok(right);
      assert.deepEqual(left.framePath, [0]);
      assert.deepEqual(right.framePath, [1]);
    },
  );
});

test('framePath captures nested iframe paths', async () => {
  await withPage(
    `
      <iframe
        srcdoc="<iframe srcdoc='<button id=&quot;nested-btn&quot;>Nested</button>'></iframe>"
      ></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const nested = session.snapshot.elements.find(
        (element) => element.attributes.id === 'nested-btn',
      );
      assert.ok(nested, 'expected nested frame button');
      assert.deepEqual(nested.framePath, [0, 0]);
    },
  );
});

test('frame and shadow paths compose inside iframe documents', async () => {
  await withPage(
    `
      <iframe
        id="combo-frame"
        srcdoc="<div id='host'></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button id=&quot;combo-btn&quot;>Combo</button>'</script>"
      ></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const combo = session.snapshot.elements.find(
        (element) => element.attributes.id === 'combo-btn',
      );
      assert.ok(combo, 'expected iframe shadow button');
      assert.deepEqual(combo.framePath, [0]);
      assert.deepEqual(combo.shadowPath, [0]);
    },
  );
});

test('shadowPath uses per-root counters for sibling shadow hosts', async () => {
  await withPage(
    `
      <div id="host-a"></div>
      <div id="host-b"></div>
      <script>
        document.getElementById('host-a').attachShadow({ mode: 'open' })
          .innerHTML = '<button id="btn-a">A</button>';
        document.getElementById('host-b').attachShadow({ mode: 'open' })
          .innerHTML = '<button id="btn-b">B</button>';
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const btnA = session.snapshot.elements.find(
        (element) => element.attributes.id === 'btn-a',
      );
      const btnB = session.snapshot.elements.find(
        (element) => element.attributes.id === 'btn-b',
      );
      assert.deepEqual(btnA.shadowPath, [0]);
      assert.deepEqual(btnB.shadowPath, [1]);
    },
  );
});

test('focusability and semantics work inside iframe documents', async () => {
  await withPage(
    `
      <iframe
        srcdoc="<style>#hidden{display:none}</style><button id='frame-visible'>Visible</button><button id='frame-hidden' style='display:none'>Hidden</button>"
      ></iframe>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const visible = session.snapshot.elements.find(
        (element) => element.attributes.id === 'frame-visible',
      );
      const hidden = session.snapshot.elements.find(
        (element) => element.attributes.id === 'frame-hidden',
      );
      assert.ok(visible);
      assert.ok(hidden);
      assert.equal(visible.rendered, true);
      assert.equal(visible.focusable, true);
      assert.equal(hidden.rendered, false);
      assert.equal(hidden.focusable, false);
    },
  );
});

test('data URL navigation resets runtime state and captures closed roots from hook', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});

  try {
    await page.setContent(
      '<div id="stale"></div><script>stale.attachShadow({mode:"closed"})</script>',
      { waitUntil: 'domcontentloaded' },
    );

    const staleSession = await createScanSession(page);
    assert.ok(
      staleSession.diagnostics.some(
        (entry) => entry.code === 'shadow-root-observation-incomplete',
      ),
    );

    const { installRuntimeHooks } = await import(
      '../src/scanner/access-scan/runtime/session.js'
    );
    await installRuntimeHooks(page);

    const navSession = await createScanSession(page, {
      url: 'data:text/html,<div id="nav-closed"></div><script>document.getElementById("nav-closed").attachShadow({mode:"closed"})</script>',
    });

    assert.equal(navSession.metrics.navigationCount, 1);
    assert.equal(navSession.metrics.runtimeInstallCount, 0);
    assert.equal(navSession.metrics.snapshotCount, 1);
    assert.equal(
      navSession.diagnostics.filter((entry) => entry.code === 'shadow-root-closed').length,
      1,
    );
    assert.equal(
      navSession.diagnostics.some(
        (entry) => entry.code === 'shadow-root-observation-incomplete',
      ),
      false,
    );
    assert.equal(
      navSession.diagnostics.some((entry) => entry.details?.hostId === 'stale'),
      false,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test('static DOM stability exits quickly without waiting full timeout', async () => {
  await withPage('<button>Static</button>', async (page) => {
    const startedAt = Date.now();
    await createScanSession(page, {
      stabilityQuietMs: 40,
      stabilityTimeoutMs: 4000,
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1500, `expected bounded quiet exit, took ${elapsed}ms`);
  });
});

test('filterByEligibility defaults to active-content when visibility omitted', async () => {
  await withPage(
    `
      <button id="visible">Visible</button>
      <button id="hidden" hidden>Hidden</button>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const buttons = queryGraph(session.snapshot, 'button');
      const defaulted = filterByEligibility(buttons);
      assert.equal(defaulted.length, 1);
      assert.equal(defaulted[0].attributes.id, 'visible');
    },
  );
});

test('large DOM snapshot stays bounded and avoids querySelectorAll star traversal', async () => {
  await withPage(
    `
      <div id="big-root"></div>
      <script>
        const root = document.getElementById('big-root');
        const parts = [];
        for (let i = 0; i < 600; i += 1) {
          parts.push('<span data-i="' + i + '">item-' + i + '</span>');
        }
        root.innerHTML = parts.join('');
      </script>
    `,
    async (page) => {
      const startedAt = Date.now();
      const session = await createScanSession(page, {
        stabilityQuietMs: 40,
        stabilityMinObserveMs: 150,
        stabilityTimeoutMs: 4000,
      });
      const elapsed = Date.now() - startedAt;
      assert.ok(session.snapshot.elements.length >= 600);
      assert.ok(elapsed < 5000, `expected bounded traversal time, took ${elapsed}ms`);

      const runtimeSource = readFileSync(
        new URL('../src/scanner/access-scan/runtime/runtime.browser.js', import.meta.url),
        'utf8',
      );
      assert.equal(runtimeSource.includes("querySelectorAll('*')"), false);
    },
  );
});

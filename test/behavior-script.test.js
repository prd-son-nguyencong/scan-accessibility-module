import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { attachBehaviorScripts } from '../src/index.js';
import { findBehaviorScript } from '../src/tracer/behavior-script.js';
import { findAttributeWriter } from '../src/tracer/script-writes.js';
import { findDataSource } from '../src/tracer/data-sidecar.js';
import { findLineForRenderedHtml } from '../src/tracer/liquid-tag-index.js';
import { narrowByOwnText } from '../src/tracer/structural-source.js';

const FILES = {
  'src/layouts/layout.liquid': '<html><body>{% block content %}{% endblock %}</body></html>\n',
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n{% render "layout/header" %}\n{% endblock %}\n',
  'src/partials/layout/header.liquid': '<nav id="nav">\n  <button type="button" class="menu-dropdown--toggle" aria-expanded="false" aria-controls="about-menu">About</button>\n  <a role="button" tabindex="0" class="olivia-cta">Join</a>\n</nav>\n',
  'src/scripts/other.js': 'document.querySelectorAll(".social").forEach((el) => {\n  el.addEventListener("focusin", () => el.classList.add("on"));\n});\n',
  'src/scripts/header.js': [
    'const menus = document.querySelectorAll(".menu-dropdown");',
    'menus.forEach((menu) => {',
    '  const toggle = menu.querySelector(".menu-dropdown--toggle");',
    '  const open = () => toggle.setAttribute("aria-expanded", "true");',
    '  menu.addEventListener("mouseenter", open);',
    '  menu.addEventListener("focusin", open);',
    '});',
    'const trap = createFocusTrap("#about-menu", { returnFocusOnDeactivate: false });',
    'document.querySelectorAll(".olivia-cta").forEach((b) => b.addEventListener("click", () => chat()));',
    '// $("#about-menu a").attr("tabindex", "-1");',
    '$("#about-menu a").attr("tabindex", "-1");',
  ].join('\n') + '\n',
};
function withSite(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-behavior-'));
  try {
    for (const [rel, body] of Object.entries(FILES)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    return fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const toggle = '<button type="button" class="menu-dropdown--toggle" aria-expanded="false" aria-controls="about-menu">About</button>';
const at = (r) => `${r.file}:${r.line}`;

test('Escape-dismissal is attributed to the focus handler tied to the trigger class, not to another script or the template', () => withSite((root) => {
  assert.equal(at(findBehaviorScript({ ruleId: 'dropdown-not-dismissible-with-escape', html: toggle, selector: '#nav>button:nth-of-type(1)' }, [], root)), 'src/scripts/header.js:6');
}));

test('focus lost after Escape names returnFocusOnDeactivate:false; tabindex -1 names the live write, never a commented one', () => withSite((root) => {
  assert.equal(at(findBehaviorScript({ ruleId: 'focus-lost-after-escape', html: toggle, selector: '#nav>button' }, [], root)), 'src/scripts/header.js:8');
  assert.equal(at(findBehaviorScript({ ruleId: 'menu-links-unreachable-by-keyboard', html: toggle, selector: '#nav>button' }, [], root)), 'src/scripts/header.js:11');
}));

test('an element no script mentions, and a rule that is not behavioural, keep the template source', () => withSite((root) => {
  assert.equal(findBehaviorScript({ ruleId: 'dropdown-not-dismissible-with-escape', html: '<button class="unrelated-widget">x</button>', selector: 'main>button' }, [], root), null);
  assert.equal(findBehaviorScript({ ruleId: 'image-alt', html: toggle, selector: '#nav>button' }, [], root), null);
}));

test('an element known only by its selector takes its tokens from the traced template snippet (dialog id)', () => withSite((root) => {
  const snippet = '    1 | <nav>\n>   2 | <div id="about-menu" role="dialog">\n    3 | </div>';
  assert.equal(at(findBehaviorScript({ ruleId: 'modal-focus-escapes', html: '', selector: 'button[aria-controls]', snippet }, [], root)), 'src/scripts/header.js:8');
}));

test('attachBehaviorScripts re-points the finding at the script and keeps the template line as alsoLikelyIn', () => withSite((root) => {
  const v = { rule: 'role-button-not-keyboard-operable', ruleId: 'role-button-not-keyboard-operable', element: { outerHTML: '<a role="button" tabindex="0" class="olivia-cta">Join</a>', selector: '#nav>a' }, origin: { owner: 'site' }, source: { file: 'src/partials/layout/header.liquid', line: 3, method: 'instrumentation-manifest', confidence: 'high' } };
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/scripts/header.js:9');
  assert.equal(v.source.method, 'script-behavior');
  assert.deepEqual(v.source.alsoLikelyIn, [{ file: 'src/partials/layout/header.liquid', line: 3 }]);
}));

test('a url repeated by several data entries resolves to the entry that also holds the element alt; a url inside a markup string resolves to that string', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-sidecar-'));
  try {
    mkdirSync(join(root, 'src/partials'), { recursive: true });
    writeFileSync(join(root, 'src/partials/paths.liquid'), '{{ x }}\n');
    writeFileSync(join(root, 'src/partials/paths.liquid.json'), JSON.stringify({ items: [{ image: 'https://cdn.test/a.png', alt: 'First one' }, { image: 'https://cdn.test/a.png', alt: 'Second one' }], notice: 'See <a href="https://x.test/legal" target="_blank">here</a>' }, null, 2));
    assert.equal(findDataSource(['src/partials/paths.liquid'], '<img src="https://cdn.test/a.png" alt="Second one">', root).dataLine, 8);
    assert.equal(findDataSource(['src/partials/paths.liquid'], '<a href="https://x.test/legal">here</a>', root).dataLine, 12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function site(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-behavior-'));
  try {
    for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    return fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const PAGE = { 'src/layouts/layout.liquid': FILES['src/layouts/layout.liquid'], 'src/pages/index.liquid': FILES['src/pages/index.liquid'] };
const HEADER = '<header id="header">\n<button type="button" class="hamburger" aria-expanded="false" aria-controls="mobile-navigation">Menu</button>\n</header>\n';
const burger = (source) => ({ rule: 'dropdown-not-dismissible-with-escape', ruleId: 'dropdown-not-dismissible-with-escape', element: { outerHTML: '<button type="button" class="hamburger" aria-expanded="false" aria-controls="mobile-navigation">Menu</button>', selector: '#header>button' }, origin: { owner: 'site' }, source: { file: 'src/partials/layout/header.liquid', line: 2, method: 'instrumentation-manifest', confidence: 'high', ...source } });

test('a handler in a sibling function never ties to the element: the template stays the source, the script is listed low', () => site({
  ...PAGE,
  'src/partials/layout/header.liquid': HEADER,
  'src/scripts/header.js': [
    'export function initDrawer() {',
    '  const button = $(".hamburger");',
    '  button.on("keydown", () => {});',
    '}',
    '',
    'export function changeHeaderColor() {',
    '  const header = document.getElementById("header");',
    '  header.addEventListener("mouseenter", () => header.classList.add("current"));',
    '}',
  ].join('\n') + '\n',
}, (root) => {
  const v = burger();
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/partials/layout/header.liquid:2');
  assert.equal(v.source.method, 'instrumentation-manifest');
  assert.equal(v.source.confidence, 'high');
}));

test('the signal in the same function as the token wins over a closer one in another function; a second pass changes nothing', () => site({
  ...PAGE,
  'src/partials/layout/header.liquid': HEADER,
  'src/scripts/header.js': [
    'export function initDrawer() {',
    '  const button = $(".hamburger");',
    '  const trap = createTrap({',
    '    onActivate: () => {',
    '      button.attr("aria-expanded", "true");',
    '    },',
    '  });',
    '}',
    'export function changeHeaderColor() {',
    '  header.addEventListener("mouseenter", () => {});',
    '}',
  ].join('\n') + '\n',
}, (root) => {
  const v = burger();
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/scripts/header.js:5');
  assert.deepEqual(v.source.templateSource, { file: 'src/partials/layout/header.liquid', line: 2 });
  const once = JSON.stringify(v.source);
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(JSON.stringify(v.source), once);
}));

test('two handlers that tie keep the template as the source and are both leads, never a pick', () => site({
  ...PAGE,
  'src/partials/layout/header.liquid': HEADER,
  'src/scripts/a.js': 'export function a() {\n  $(".hamburger").on("focusin", () => {});\n}\n',
  'src/scripts/b.js': 'export function b() {\n  $(".hamburger").on("focusin", () => {});\n}\n',
}, (root) => {
  const v = burger();
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(v.source.file, 'src/partials/layout/header.liquid');
  assert.deepEqual(v.source.alsoLikelyIn.map((x) => `${x.file}:${x.line}:${x.confidence}`), ['src/scripts/a.js:2:low']);
}));

test('a bare tag name from the selector is not an identifying token', () => site({
  'src/scripts/forms.js': 'document.querySelectorAll("input").forEach((i) => i.classList.add("x"));\ndocument.querySelector(".newsletter-submit").addEventListener("click", () => send());\n',
}, (root) => {
  assert.equal(findBehaviorScript({ ruleId: 'role-button-not-keyboard-operable', html: '<div role="button" tabindex="0" class="tile-wide">x</div>', selector: 'form>label>input' }, [], root), null);
}));

test('a module-level element reference ties to the handler function below it', () => site({
  'src/scripts/drawer.js': ['const drawer = document.getElementById("nav-drawer");', 'const open = () => {', '  drawer.classList.remove("hidden");', '};'].join('\n') + '\n',
}, (root) => {
  const snippet = '>  1 | <div\n   2 |   id="nav-drawer"\n';
  assert.equal(at(findBehaviorScript({ ruleId: 'modal-focus-escapes', html: '', selector: 'button[aria-controls]', snippet }, [], root)), 'src/scripts/drawer.js:3');
}));

test('a disabled restore of the tabindex write is the line to bring back', () => site({
  'src/scripts/header.js': [
    'export function initDrawerMenu() {',
    '  document.querySelectorAll(".sub-menu").forEach((c) => {',
    '    const b = c.querySelector(".sub-menu-toggle");',
    '    const $m = $(c.querySelector(".sub-menu-content"));',
    '    $m.find("a, button").attr("tabindex", "-1");',
    '    const t = createFocusTrap(c, {',
    '      onActivate: () => {',
    '        // $m.find("a, button").attr("tabindex", "0").first().focus();',
    '      },',
    '    });',
    '  });',
    '}',
  ].join('\n') + '\n',
}, (root) => {
  const r = findBehaviorScript({ ruleId: 'menu-links-unreachable-by-keyboard', html: '<button class="sub-menu-toggle nav-link">x</button>', selector: 'nav>button' }, [], root);
  assert.equal(at(r), 'src/scripts/header.js:8');
  assert.deepEqual(r.candidates[0], { file: 'src/scripts/header.js', line: 5 });
}));

test('markup a shared component authors is the source of a role=button finding; the click binding is the workaround', () => site({
  ...PAGE,
  'src/partials/layout/header.liquid': '<div id="cta">\n{% render "button", text: "Chat", oliviaButton: true %}\n</div>\n',
  'src/components/button.liquid': '<a\n  {% if oliviaButton %}role="button" tabindex="0"{% endif %}\n  class="button-text oliviaButton">{{ text }}</a>\n',
  'src/scripts/index.js': 'document.querySelectorAll(".oliviaButton").forEach((el) => {\n  el.addEventListener("click", () => chat());\n});\n',
}, (root) => {
  const v = { rule: 'role-button-not-keyboard-operable', ruleId: 'role-button-not-keyboard-operable', element: { outerHTML: '<a role="button" tabindex="0" class="button-text oliviaButton">Chat</a>', selector: '#cta>a' }, origin: { owner: 'site' }, source: { file: 'src/partials/layout/header.liquid', line: 2, method: 'liquid-tag-index', confidence: 'high' } };
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(v.source.file, 'src/components/button.liquid');
  assert.deepEqual(v.source.templateSource, { file: 'src/partials/layout/header.liquid', line: 2 });
  assert.deepEqual(v.source.alsoLikelyIn.map((x) => `${x.file}:${x.line}:${x.confidence}`), ['src/scripts/index.js:2:low', 'src/partials/layout/header.liquid:2:undefined']);
}));

test('a tag whose whole class list is on the element beats a smaller tag that only shares a state class; same-looking pills are told apart by their text', () => site({
  'src/partials/paths.liquid': [
    '<nav>',
    '  <button class="button-font current:text-azure hocus:text-azure current py-1 transition-colors">Tab</button>',
    '</nav>',
    '<div class="dots">',
    '  <button',
    '    class="border-azure current:bg-azure hocus:bg-azure size-1 rounded-full border-[0.1rem] border-solid bg-white transition-colors"></button>',
    '</div>',
    '<nav id="people">',
    '  <button aria-label="See people" class="pill a">',
    '    Customer-Facing',
    '  </button>',
    '  <button aria-label="See people" class="pill a">',
    '    Corporate',
    '  </button>',
    '</nav>',
  ].join('\n') + '\n',
}, (root) => {
  const dot = '<button class="border-azure current:bg-azure hocus:bg-azure size-1 rounded-full border-[0.1rem] border-solid bg-white transition-colors current"></button>';
  assert.equal(findLineForRenderedHtml('src/partials/paths.liquid', dot, root).line, 5);
  const pills = [{ file: 'src/partials/paths.liquid', line: 9 }, { file: 'src/partials/paths.liquid', line: 12 }];
  assert.deepEqual(narrowByOwnText(pills, '<button aria-label="See people" class="pill a">Corporate</button>', root), [pills[1]]);
  assert.deepEqual(narrowByOwnText(pills, '<button aria-label="See people" class="pill a"></button>', root), pills);
}));

test('role=button emitted by a component that builds its class from a captured variable is attributed to the component through the render flag; a template without the flag keeps the script (paired)', () => {
  const button = ['{% capture buttonClass %}button button--{{ type }}{% if oliviaButton %} oliviaButton cursor-pointer{% endif %}{% endcapture %}',
    '<a', '  {% if oliviaButton %}', '    role="button" tabindex="0"', '  {% else %}', '    href="{{ link }}"', '  {% endif %}', '  class="{{ buttonClass }}">', '  <span>{{ text }}</span>', '</a>'].join('\n') + '\n';
  const files = {
    ...PAGE,
    'src/components/button.liquid': button,
    'src/partials/layout/header.liquid': '<div>\n{% render "button", text: "Chat", oliviaButton: true %}\n</div>\n',
    'src/scripts/index.js': 'document.querySelectorAll(".oliviaButton").forEach((el) => {\n  el.addEventListener("click", () => chat());\n});\n',
  };
  const live = (flag) => `<a data-pdk-render="button" data-pdk-param-text="'Chat'" ${flag ? 'data-pdk-param-oliviabutton="true" ' : ''}role="button" tabindex="0" class="button button--primary oliviaButton cursor-pointer"><span>Chat</span></a>`;
  const finding = (html) => ({ rule: 'role-button-not-keyboard-operable', ruleId: 'role-button-not-keyboard-operable', element: { outerHTML: html, selector: '#bridget>a' }, origin: { owner: 'site' }, source: { file: 'src/partials/layout/header.liquid', line: 2, method: 'instrumentation-manifest', confidence: 'high' } });
  site(files, (root) => {
    const v = finding(live(true));
    attachBehaviorScripts([v], 'src/pages/index.liquid', root);
    assert.equal(`${v.source.file}:${v.source.line}`, 'src/components/button.liquid:2');
    assert.equal(v.source.method, 'component-markup');
    assert.deepEqual(v.source.alsoLikelyIn.map((x) => `${x.file}:${x.line}`), ['src/scripts/index.js:2', 'src/partials/layout/header.liquid:2']);
  });
  site({ ...files, 'src/components/button.liquid': button.replaceAll('oliviaButton', 'otherFlag') }, (root) => {
    const v = finding(live(true));
    attachBehaviorScripts([v], 'src/pages/index.liquid', root);
    assert.equal(`${v.source.file}:${v.source.line}`, 'src/scripts/index.js:2', 'no component writes this flag: the script stays the source');
  });
});

test('aria-expanded-not-updated is attributed to the handler that shows the panel (slideToggle), not to the template that renders the toggle', () => site({
  ...PAGE,
  'src/partials/layout/header.liquid': '<div>\n<button aria-controls="share-popup" aria-expanded="false" class="social-share--toggle">Share</button>\n</div>\n',
  'src/scripts/job-details.js': [
    'window.addEventListener("DOMContentLoaded", () => {',
    '  document.querySelectorAll(".social-share--toggle").forEach((toggle) => {',
    '    toggle.addEventListener("click", () => {',
    '      $(toggle).parent().find("#share-popup").slideToggle(200);',
    '    });',
    '  });',
    '});',
  ].join('\n') + '\n',
}, (root) => {
  const v = { rule: 'aria-expanded-not-updated', ruleId: 'aria-expanded-not-updated', element: { outerHTML: '<button aria-controls="share-popup" aria-expanded="false" class="social-share--toggle">Share</button>', selector: '#main>button' }, origin: { owner: 'site' }, source: { file: 'src/partials/layout/header.liquid', line: 2, method: 'liquid-tag-index', confidence: 'medium' } };
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/scripts/job-details.js:4');
  assert.equal(v.source.method, 'script-behavior');
}));

test('an aria-label that SplitText writes is attributed to the constructor call even when axe shortened the value to "..."; aria:"none" opts out (paired)', () => {
  const html = '<p class="highlight-on-scroll ..." aria-label="With colleagues in m...">';
  const files = (call) => ({ 'src/partials/stats.liquid': '<p class="highlight-on-scroll h4">\n  With colleagues in more than 150 countries, we offer.\n</p>\n', 'src/scripts/index.js': ['(function () {', '  if (document.querySelectorAll(".highlight-on-scroll").length === 0) return;', `  const split = new SplitText(".highlight-on-scroll", ${call});`, '})();'].join('\n') + '\n' });
  site(files('{ type: "lines" }'), (root) => {
    const w = findAttributeWriter({ html, selector: '.highlight-on-scroll', ruleId: 'aria-prohibited-attr', layer: 'axe' }, ['src/partials/stats.liquid'], root);
    assert.equal(`${w.file}:${w.line}`, 'src/scripts/index.js:3');
    assert.equal(w.attr, 'aria-label');
  });
  site(files('{ type: "lines", aria: "none" }'), (root) => {
    assert.equal(findAttributeWriter({ html, selector: '.highlight-on-scroll', ruleId: 'aria-prohibited-attr', layer: 'axe' }, ['src/partials/stats.liquid'], root), null);
  });
  site({ ...files('{ type: "lines" }'), 'src/partials/stats.liquid': '<p class="highlight-on-scroll h4" aria-label="With colleagues in more than 150 countries">\n</p>\n' }, (root) => {
    assert.equal(findAttributeWriter({ html, selector: '.highlight-on-scroll', ruleId: 'aria-prohibited-attr', layer: 'axe' }, ['src/partials/stats.liquid'], root), null, 'a label the template writes is the template\'s');
  });
});

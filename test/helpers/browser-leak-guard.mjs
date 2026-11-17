// Preloaded by `npm test` (--import). A browser a test file forgets to close keeps its process alive forever
// (--test-timeout cannot help), so once the file's tests are done, anything still running as our child
// gets a grace period, is then killed, and the file fails.
import { liveBrowserChildren } from '../../src/utils/process-tree.js';
import { after } from 'node:test';

const GRACE_MS = Number(process.env.ADA_SCAN_TEST_LEAK_GRACE_MS) || 20_000;
export { liveBrowserChildren };

after(() => {
  setTimeout(() => {
    const leaked = liveBrowserChildren();
    if (!leaked.length) return;
    console.error(`browser-leak-guard: ${leaked.length} headless browser process(es) still alive ${GRACE_MS}ms after the tests finished (pid ${leaked.map((r) => r.pid).join(', ')}); close the browser or context in an after() hook`);
    for (const r of leaked) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* already gone */ } }
    process.exit(1);
  }, GRACE_MS).unref(); // unref: a clean file exits first and never fires it
});

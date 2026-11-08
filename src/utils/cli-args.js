import { parseArgs } from 'node:util';
import { removedMessage } from '../fixer/fix-mode.js';

/** Bad command line or config: the CLI prints the message and exits 2. */
export class CliError extends Error {
  exitCode = 2;
}

const BOOLEANS = [
  'dry-run', 'fix', 'baseline', 'report-only', 'force-build', 'changed-only', 'ui', 'all',
  'verbose', 'no-fail', 'allow-incomplete', 'require-trace', 'include-third-party', 'exclude-third-party', 'no-hydrate-jobs', 'no-reverify',
  'psi', 'no-psi', 'allow-external', 'fail-on-violations', 'gate', 'perf-gate', 'seo-gate', 'no-server', 'ad-hoc', 'crawl', 'keep-query',
];
export const PROFILES = ['standards', 'commercial-parity'];
const STRINGS = ['profile', 'url', 'page', 'layers', 'source', 'session', 'fix-mode', 'out-dir', 'sitemap', 'max-pages', 'crawl-per-template', 'max-time', 'lighthouse-runs', 'sarif'];

const opts = (booleans, strings) => ({
  help: { type: 'boolean', short: 'h' },
  ...Object.fromEntries(booleans.map((n) => [n, { type: 'boolean' }])),
  ...Object.fromEntries(strings.map((n) => [n, { type: 'string' }])),
});

export const SCAN_OPTIONS = opts(BOOLEANS, STRINGS);
export const FIX_OPTIONS = opts(['ui', 'export', 'include-needs-review', 'dry-run', 'group-by-file', 'harness', 'verify', 'from-working-tree'], ['report', 'source', 'session', 'out-dir', 'fix-mode', 'severity', 'rule', 'page', 'max', 'target', 'fixer', 'max-repairs', 'baseline']);

const CONFLICTS = [
  ['include-third-party', 'exclude-third-party'],
  ['psi', 'no-psi'],
  ['url', 'page'],
  ['all', 'page'],
];

const REMOVED_FLAGS = ['--ai', '--agent', '--legacy-fix'];

/** Strict parse: unknown flag, missing value, a flag used as a value, stray positional or conflicting flags throw CliError. */
export function parseCliArgs(rawArgs, options = SCAN_OPTIONS) {
  const removed = rawArgs.find((a) => REMOVED_FLAGS.includes(a));
  if (removed) throw new CliError(removedMessage(removed));
  let values;
  // --sarif takes an optional file: a bare flag (last, or before another flag) means the default path.
  const args = rawArgs.map((a, i) => (a === '--sarif' && !(rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) ? '--sarif=' : a));
  try {
    ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new CliError(`${err.message}\nRun "ada-scan --help" for usage.`);
  }
  if (values.profile !== undefined && !PROFILES.includes(values.profile)) {
    throw new CliError(`--profile must be one of ${PROFILES.join(', ')}.`);
  }
  for (const [a, b] of CONFLICTS) {
    if (options[a] && options[b] && values[a] !== undefined && values[b] !== undefined) {
      throw new CliError(`--${a} cannot be combined with --${b}.`);
    }
  }
  return values;
}

export const USAGE = `ada-scan - WCAG/ADA, HTML validity and page-speed scanner

Usage:
  ada-scan [flags]            scan the local site (starts dev server, builds instrumented dist)
  ada-scan --url <url>        scan a remote or local URL
  ada-scan init | fix | demo  subcommands (ada-scan fix --report <file> --source <dir>)
  ada-scan fix [--export]     write one task per finding + INDEX.md to <out-dir>/tasks (no AI); filters: --severity <level or worse>,
                              --rule <id,id>, --page <route>, --max <n>, --include-needs-review,
                              --target <generic|cursor|claude> (adds .cursor/rules/ada-scan.mdc or .claude/ada-scan.md and the fix skill), --dry-run,
                              --group-by-file (one combined task per source file)
  ada-scan fix --verify       check the working tree diff against the export (files, data tags, colours, dist/); --baseline <report>
  ada-scan fix --fix-mode cis trusted fix pipeline (advisory CIS, verified apply)
  ada-scan fix --harness      gated fix harness on a shadow copy: [--fixer recipes|cis|external] [--max-repairs K] [--dry-run];
                              add --from-working-tree to verify what an editor agent (Cursor chat, Claude Code) already changed (git diff HEAD) per task
                              (always a dry run: your edits stay in the working tree; unclaimed hunks are listed in the report);
                              needs a local source tree and verifyBuildCommand in .scan-config.json (URL-only reports stay scan-only)
  ada-scan doctor             check Node, Chromium, lockfile, CIS env, output dir (--url <url> --json)
  ada-scan manual list|sign|status   record manual WCAG checks (tool-owned manual-checks.json in the reports dir)
  ada-scan label <stableId> --tp|--fp   label a finding; labels stats|apply show rule precision and demote weak rules

Flags:
  -h, --help                  print this help and exit
  --url <url>                 scan this URL instead of the configured local site
  --page <name|path>          scan one configured page (--ad-hoc allows a path that is not configured)
  --ad-hoc                    with --page: allow a path that is not in config.pages
  --all                       scan all configured pages (default)
  --sitemap <url|file>        discover pages from a sitemap
  --crawl                     discover pages by a bounded same-origin crawl
  --max-pages <n>             cap discovered pages (default 50)
  --crawl-per-template <n>    with --crawl: sample pages kept per URL template, e.g. /:slug/job/:id (default 2)
  --changed-only              scan only pages whose source files changed in git
  --layers <a,b>              comma list of layers to run (axe, accessScan, w3c, links, lighthouse, ...)
  --lighthouse-runs <n>       local Lighthouse runs per form factor; the median score is reported (default 1)
  --profile <name>            standards (default; decides pass/fail) | commercial-parity (adds a supplementary section that never affects the gate)
  --include-third-party       keep third-party widget DOM in fixes and checks (does not select a profile)
  --exclude-third-party       drop third-party widget findings
  --no-hydrate-jobs           block jobs/chat bundles (implies --exclude-third-party)
  --no-reverify               skip re-checking flaky-prone findings in a fresh context (on by default)
  --allow-external            allow third-party services: W3C Nu validator, PageSpeed Insights (off by default)
  --psi / --no-psi            enable / disable PageSpeed Insights (--psi implies the opt-in for PSI only)
  --fix                       run the trusted fix pipeline (--fix-mode cis, the default; --ui)
  --dry-run                   do not write files
  --baseline                  save results as the baseline later scans compare against (fixed, remaining, new)
  --sarif [file]              also write a SARIF 2.1.0 export (default <out-dir>/scan.sarif)
  --keep-query                keep URL query strings in reports (redacted by default; fragments and userinfo are always dropped)
  --report-only               regenerate HTML reports from the last scan
  --fail-on-violations        exit 1 when violations exist
  --gate                      exit 1 when a metric misses its threshold (config thresholds; performance only off a dev server)
  --perf-gate                 enforce performance thresholds even on a dev server
  --seo-gate                  enforce Lighthouse SEO thresholds even when the target is noindex (preview)
  --no-fail                   never exit 1 for violations
  --max-time <seconds>        wall-clock budget; pages not started in time are skipped (incomplete, exit 2)
  --allow-incomplete          do not exit 2 for an incomplete scan
  --require-trace             fail (exit 2) when source tracing is unavailable for a local URL scan
  --force-build               rebuild the instrumented dist
  --no-server                 do not start the dev server
  --source <dir>              source root for fixes
  --session <id>              resume a fix session
  --out-dir <dir>             reports directory (default .ada-scan)
  --verbose                   print more detail

Exit codes: 0 ok, 1 violations/failure, 2 bad arguments/config or incomplete scan.
`;

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  captureLiveSnapshot,
  CorpusToolingError,
  DEFAULT_PAGE_STATE,
  generateDraftCase,
  isCorpusToolingError,
  printDeterministicJson,
} from './index.js';
import { normalizeCliArgs } from './lib/cli-args.js';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/**
 * @param {Record<string, string | boolean | undefined>} values
 */
function parseViewport(values) {
  const width = Number.parseInt(String(values['viewport-width'] || ''), 10);
  const height = Number.parseInt(String(values['viewport-height'] || ''), 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

/**
 * @param {Record<string, string | boolean | undefined>} values
 */
async function loadReport(values) {
  if (typeof values.report === 'string') {
    return JSON.parse(readFileSync(values.report, 'utf8'));
  }
  if (typeof values['report-json'] === 'string') {
    return JSON.parse(values['report-json']);
  }
  return null;
}

/**
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {Promise<{
 *   captureAdapter: () => Promise<Record<string, unknown>>,
 *   cleanup?: () => Promise<void>,
 * } | null>}
 */
async function createCaptureAdapter(values) {
  if (typeof values.snapshot === 'string') {
    const snapshot = JSON.parse(readFileSync(values.snapshot, 'utf8'));
    return {
      captureAdapter: async () => snapshot,
    };
  }

  if (typeof values.url === 'string') {
    const { ensurePlaywrightTempDir } = await import('./lib/replay.js');
    ensurePlaywrightTempDir();
    const { chromium } = await import('playwright');
    /** @type {import('playwright').Browser | null} */
    let browser = null;
    /** @type {import('playwright').Page | null} */
    let page = null;
    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      const viewport = parseViewport(values);
      if (viewport) await page.setViewportSize(viewport);
      return {
        captureAdapter: async (context) => captureLiveSnapshot(page, {
          url: values.url,
          viewport: context.viewport,
          captureState: context.captureState,
        }),
        cleanup: async () => {
          await page?.close().catch(() => {});
          await browser?.close().catch(() => {});
        },
      };
    } catch (error) {
      await page?.close().catch(() => {});
      await browser?.close().catch(() => {});
      throw error;
    }
  }

  return null;
}

/**
 * @param {string[]} argv
 */
export async function runCorpusCaptureCli(argv = normalizeCliArgs(process.argv.slice(2))) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      draft: { type: 'string' },
      id: { type: 'string' },
      report: { type: 'string' },
      'report-json': { type: 'string' },
      snapshot: { type: 'string' },
      url: { type: 'string' },
      'page-html': { type: 'string' },
      overwrite: { type: 'boolean', default: false },
      'viewport-width': { type: 'string' },
      'viewport-height': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printDeterministicJson({
      ok: true,
      command: 'corpus:capture',
      usage: [
        'node scripts/accessscan-corpus/capture.js --draft <dir> --id <case-id> --report <report.json> --snapshot <snapshot.json>',
        'node scripts/accessscan-corpus/capture.js --draft <dir> --id <case-id> --report <report.json> --url <url>',
      ],
      limitations: [
        `Live --url capture supports only pageState "${DEFAULT_PAGE_STATE}" from the report. Non-initial states require programmatic capture with stateAdapter.`,
      ],
    });
    return 0;
  }

  if (!values.draft || !values.id) {
    printDeterministicJson({
      ok: false,
      errorCode: 'incomplete_report',
      message: '--draft and --id are required',
    });
    return 1;
  }

  const report = await loadReport(values);
  if (!report) {
    printDeterministicJson({
      ok: false,
      errorCode: 'incomplete_report',
      message: 'Provide --report and either --snapshot or --url',
    });
    return 1;
  }

  if (
    typeof values.url === 'string'
    && typeof report.pageState === 'string'
    && report.pageState !== DEFAULT_PAGE_STATE
  ) {
    printDeterministicJson({
      ok: false,
      errorCode: 'unsupported_page_state',
      message: `Live --url capture supports only pageState "${DEFAULT_PAGE_STATE}"; received "${report.pageState}". Use programmatic capture with stateAdapter for other states.`,
      details: { pageState: report.pageState },
    });
    return 1;
  }

  const adapterBundle = await createCaptureAdapter(values);
  if (!adapterBundle) {
    printDeterministicJson({
      ok: false,
      errorCode: 'incomplete_report',
      message: 'Provide --report and either --snapshot or --url',
    });
    return 1;
  }

  const pageHtml = typeof values['page-html'] === 'string'
    ? readFileSync(values['page-html'], 'utf8')
    : undefined;

  try {
    const result = await generateDraftCase({
      id: values.id,
      draftDir: values.draft,
      report,
      captureAdapter: adapterBundle.captureAdapter,
      pageHtml,
      overwrite: Boolean(values.overwrite),
    });
    printDeterministicJson({
      ok: true,
      command: 'corpus:capture',
      draftDir: result.draftDir,
      files: result.files,
      caseId: result.meta.id,
    });
    return 0;
  } catch (error) {
    const payload = isCorpusToolingError(error)
      ? {
        ok: false,
        errorCode: error.errorCode,
        message: error.message,
        details: error.details || null,
      }
      : {
        ok: false,
        errorCode: 'schema_failure',
        message: error instanceof Error ? error.message : String(error),
      };
    printDeterministicJson(payload);
    return 1;
  } finally {
    if (adapterBundle.cleanup) {
      await adapterBundle.cleanup();
    }
  }
}

if (isMain) {
  runCorpusCaptureCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const payload = error instanceof CorpusToolingError
      ? {
        ok: false,
        errorCode: error.errorCode,
        message: error.message,
        details: error.details || null,
      }
      : {
        ok: false,
        errorCode: 'schema_failure',
        message: error instanceof Error ? error.message : String(error),
      };
    printDeterministicJson(payload);
    process.exitCode = 1;
  });
}

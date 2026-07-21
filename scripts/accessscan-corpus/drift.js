#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CorpusToolingError,
  evaluateCorpusDrift,
  getCommittedFixtureRoot,
  isCorpusToolingError,
  printDeterministicJson,
  serializeDeterministicJson,
} from './index.js';
import {
  buildDriftArtifactPayload,
  buildDriftHumanSummary,
} from './lib/drift-artifact.js';
import { evaluateCorpusDriftAll } from './lib/drift-manifest.js';
import { normalizeSanitizedDriftError, assertNeutralDriftArtifact, sanitizeDiagnosticText } from './lib/drift-error.js';
import { normalizeCliArgs } from './lib/cli-args.js';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/**
 * @param {Record<string, string | boolean | undefined>} values
 */
function createFixtureCaptureEntry(values) {
  if (typeof values['capture-fixture-snapshot'] !== 'string') {
    return null;
  }

  const snapshot = JSON.parse(readFileSync(values['capture-fixture-snapshot'], 'utf8'));
  const report = typeof values['capture-fixture-report'] === 'string'
    ? JSON.parse(readFileSync(values['capture-fixture-report'], 'utf8'))
    : { findings: [] };

  return async () => ({
    snapshot,
    findings: Array.isArray(report.findings) ? report.findings : [],
  });
}

/**
 * @param {string[]} argv
 */
export async function runCorpusDriftCli(argv = normalizeCliArgs(process.argv.slice(2))) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      all: { type: 'boolean', default: false },
      root: { type: 'string' },
      manifest: { type: 'string' },
      'case-id': { type: 'string' },
      snapshot: { type: 'string' },
      report: { type: 'string' },
      'actual-findings': { type: 'string' },
      'output-dir': { type: 'string' },
      'capture-fixture-snapshot': { type: 'string' },
      'capture-fixture-report': { type: 'string' },
      'capture-fixture-mode': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printDeterministicJson({
      ok: true,
      command: 'corpus:drift',
      usage: [
        'node scripts/accessscan-corpus/drift.js --case-id <id> [--snapshot <snapshot.json> --report <report.json>]',
        'node scripts/accessscan-corpus/drift.js --case-id <id> --actual-findings <expected.json>',
        'node scripts/accessscan-corpus/drift.js --all [--root <corpus-root>] [--manifest <source-manifest.json>] [--output-dir <dir>]',
      ],
    });
    return 0;
  }

  if (values.all) {
    const corpusRoot = values.root || getCommittedFixtureRoot();
    const fixtureCapture = createFixtureCaptureEntry(values);
    const useCommittedFixtureMode = values['capture-fixture-mode'] === 'committed';

    try {
      const result = await evaluateCorpusDriftAll({
        corpusRoot,
        manifestPath: typeof values.manifest === 'string' ? values.manifest : undefined,
        captureEntry: useCommittedFixtureMode
          ? async ({ context }) => ({
            snapshot: context.snapshot,
            findings: context.expected.findings,
          })
          : fixtureCapture
            ? async () => fixtureCapture()
            : undefined,
      });
      const payload = buildDriftArtifactPayload(result);
      assertNeutralDriftArtifact(payload);

      if (typeof values['output-dir'] === 'string') {
        const outputDir = path.resolve(values['output-dir']);
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(
          path.join(outputDir, 'drift-report.json'),
          serializeDeterministicJson(payload),
          'utf8',
        );
        writeFileSync(
          path.join(outputDir, 'drift-summary.md'),
          buildDriftHumanSummary(payload),
          'utf8',
        );
      }

      printDeterministicJson(payload);
      return result.observedExitCode;
    } catch (error) {
      const normalized = normalizeSanitizedDriftError(error);
      const payload = {
        ok: false,
        errorCode: normalized.errorCode,
        message: normalized.message,
        command: 'corpus:drift',
        mode: 'manifest-all',
        observedExitCode: 1,
        snapshotDrift: null,
      };
      assertNeutralDriftArtifact(payload);
      printDeterministicJson(payload);
      return 1;
    }
  }

  if (!values['case-id']) {
    printDeterministicJson({
      ok: false,
      errorCode: 'incomplete_report',
      message: '--case-id is required unless --all is provided',
    });
    return 1;
  }

  const snapshot = typeof values.snapshot === 'string'
    ? JSON.parse(readFileSync(values.snapshot, 'utf8'))
    : undefined;
  const report = typeof values.report === 'string'
    ? JSON.parse(readFileSync(values.report, 'utf8'))
    : undefined;
  const actualFindings = typeof values['actual-findings'] === 'string'
    ? JSON.parse(readFileSync(values['actual-findings'], 'utf8')).findings
    : undefined;

  try {
    const result = await evaluateCorpusDrift({
      caseId: values['case-id'],
      corpusRoot: values.root || getCommittedFixtureRoot(),
      snapshot,
      report,
      actualFindings,
    });
    printDeterministicJson({
      ok: result.ok,
      command: 'corpus:drift',
      caseId: result.caseId,
      snapshotDrift: result.snapshotDrift,
      findingsEquivalent: result.findingsEquivalent,
      diff: {
        equivalent: result.diff.equivalent,
        missing: result.diff.missing.map((entry) => entry.key),
        extra: result.diff.extra.map((entry) => entry.key),
        changed: result.diff.changed.map((pair) => ({
          expected: pair.expected.key,
          actual: pair.actual.key,
        })),
      },
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    const normalized = normalizeSanitizedDriftError(error);
    const payload = {
      ok: false,
      errorCode: normalized.errorCode,
      message: normalized.message,
    };
    printDeterministicJson(payload);
    return 1;
  }
}

if (isMain) {
  runCorpusDriftCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const normalized = normalizeSanitizedDriftError(error);
    const payload = {
      ok: false,
      errorCode: normalized.errorCode,
      message: normalized.message,
      snapshotDrift: null,
    };
    try {
      assertNeutralDriftArtifact(payload);
    } catch {
      payload.message = sanitizeDiagnosticText('Live drift failed before artifact emission');
    }
    printDeterministicJson(payload);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CorpusToolingError,
  getCommittedFixtureRoot,
  isCorpusToolingError,
  printDeterministicJson,
  verifyCorpus,
} from './index.js';
import { normalizeCliArgs } from './lib/cli-args.js';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/**
 * @param {string[]} argv
 */
export async function runCorpusVerifyCli(argv = normalizeCliArgs(process.argv.slice(2))) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      root: { type: 'string' },
      'schema-only': { type: 'boolean', default: false },
      'source-manifest': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printDeterministicJson({
      ok: true,
      command: 'corpus:verify',
      usage: ['node scripts/accessscan-corpus/verify.js [--root <corpus-root>] [--schema-only]'],
    });
    return 0;
  }

  const corpusRoot = values.root || getCommittedFixtureRoot();

  try {
    const result = await verifyCorpus(corpusRoot, {
      schemaOnly: Boolean(values['schema-only']),
      sourceManifestPath: typeof values['source-manifest'] === 'string'
        ? values['source-manifest']
        : undefined,
    });
    printDeterministicJson({
      ok: result.ok,
      command: 'corpus:verify',
      corpusRoot: result.corpusRoot,
      caseCount: result.cases.length,
      cases: result.cases.map((entry) => ({
        id: entry.id,
        path: entry.path,
        ok: entry.ok,
        diff: entry.diff,
      })),
      errors: result.errors,
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    const payload = isCorpusToolingError(error)
      ? {
        ok: false,
        errorCode: error.errorCode,
        message: error.message,
        details: error.details || null,
        cases: Array.isArray(error.details?.cases)
          ? error.details.cases.map((entry) => ({
            id: entry.id,
            path: entry.path,
            ok: entry.ok,
            diff: entry.diff,
          }))
          : null,
      }
      : {
        ok: false,
        errorCode: 'schema_failure',
        message: error instanceof Error ? error.message : String(error),
      };
    printDeterministicJson(payload);
    return 1;
  }
}

if (isMain) {
  runCorpusVerifyCli().then((code) => {
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

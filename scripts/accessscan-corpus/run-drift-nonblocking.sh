#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${1:-${ROOT_DIR}/.tmp-drift-artifacts}"
MANIFEST_PATH="${2:-${ROOT_DIR}/scripts/accessscan-corpus/source-manifest.json}"
STDERR_RAW="${OUTPUT_DIR}/.drift-stderr.raw.log"
STDERR_SANITIZED="${OUTPUT_DIR}/drift-stderr.sanitized.log"

mkdir -p "$OUTPUT_DIR"

cleanup_raw_stderr() {
  rm -f "$STDERR_RAW"
}
trap cleanup_raw_stderr EXIT

cd "$ROOT_DIR"

set +e
node scripts/accessscan-corpus/drift.js \
  --all \
  --manifest "$MANIFEST_PATH" \
  --output-dir "$OUTPUT_DIR" \
  1> "${OUTPUT_DIR}/drift-cli.stdout.json" \
  2> "$STDERR_RAW"
OBSERVED_EXIT=$?
set -e

if [[ -s "$STDERR_RAW" ]]; then
  node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs';
import { sanitizeDriftStderr } from './scripts/accessscan-corpus/lib/drift-error.js';
const raw = readFileSync('${STDERR_RAW}', 'utf8');
writeFileSync('${STDERR_SANITIZED}', \`\${sanitizeDriftStderr(raw)}\n\`, 'utf8');" || printf '\n' > "$STDERR_SANITIZED"
else
  printf '\n' > "$STDERR_SANITIZED"
fi

cleanup_raw_stderr
trap - EXIT

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "observed_exit_code=${OBSERVED_EXIT}"
    echo "artifact_dir=${OUTPUT_DIR}"
  } >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "${OUTPUT_DIR}/drift-summary.md" ]]; then
  cat "${OUTPUT_DIR}/drift-summary.md" >> "$GITHUB_STEP_SUMMARY"
fi

if [[ ! -f "${OUTPUT_DIR}/drift-report.json" ]]; then
  printf '%s\n' '{"ok":false,"command":"corpus:drift","mode":"manifest-all","message":"drift report was not written"}' > "${OUTPUT_DIR}/drift-report.json"
fi

echo "accessscan drift observed exit code: ${OBSERVED_EXIT} (job remains successful)"
exit 0

# CIS contract (milestone `cis-contract`)

Workday CIS is **untrusted advisory output** for the fix-ada PoC. This document freezes
the transport envelope and redacted fixtures used by contract tests. The trusted
runtime transport and strict parser live under `src/fix/cis/`.

## Contract status (2026-07)

| Area | Status |
| --- | --- |
| Trusted TLS transport | Implemented — pinned CA bundle + hostname allowlist; `rejectUnauthorized: true` (default) |
| Guarded `insecure-dev` transport | Implemented — local-only; TLS 1.2 Undici dispatcher; explicit ack + auth bypass guards; refused in CI/production |
| Guarded `insecure-dev` live model inventory | **Verified** — canonical selectable IDs returned; pipe-composite registry rows skipped |
| Live prediction + sandbox demo acceptance | **Pending** — Step 5 operator workflow (proposal → verify → apply → rollback) not yet recorded |
| Legacy HTTP characterization (2026-07-14) | **Blocked** — unpinned probe failed before TLS trust was established |
| Response fixtures | **Synthetic-inferred** until a verified-TLS on-network capture replaces them (`observed-live-redacted`) |
| Production model discovery | `GET …/v1alpha1/models` — trusted mode never sends `bypass_auth`; `insecure-dev` sends `bypass_auth=true` only with all guards |
| Sandbox one-file demo | `pnpm cis:demo` — persistent sandbox, artifact export, authenticated rollback (local operator workflow) |
| Operator provisioning | `pnpm cis:configure`, `pnpm cis:models`, `pnpm cis:benchmark`, `pnpm cis:demo` (see package README) |

### Implementation verification (2026-07-16)

Baseline evidence from the secure live CIS implementation. Test counts may change as the
suite evolves; this records a point-in-time baseline, not a promise they stay constant.

| Command (from `ada-scan/`) | Result (2026-07-16) |
| --- | --- |
| `node --test test/cis-redaction.test.js test/cis-contract.test.js` | 25/25 pass |
| `node --test test/fix/*.test.js` | 491/491 pass (trusted-fix baseline) |
| `pnpm test` | 851/851 pass |
| `pnpm build` (after `cd ..` from `ada-scan/`) | exit 0 |

## What is actually observed

The **2026-07-14** characterization probe recorded only a network-layer failure before
trust could be established. No HTTP response bodies were captured on-network. Subsequent
live work requires an operator-provided PEM bundle and `sha256:<64hex>` fingerprint from
Workday Trust Star/PKI/JAMF — not a certificate exported from an unverified connection.

| Observation | Value |
| --- | --- |
| Probe attempted | yes (`2026-07-14`) |
| Network reachable | **no** — `fetch failed` (untrusted private CA blocked verified TLS) |
| Fixture | `test/fixtures/cis/responses/characterization-network-unreachable.json` (`observed-environment`) |
| Verified-TLS capture | **pending** — replace synthetic response fixtures when available |

Request envelopes below are **Bruno-derived** (sanitized excerpts), not live observed.
Response envelopes are **synthetic-inferred** placeholders unless later replaced with
`observed-live-redacted` captures.

## Bruno evidence (reproducible, no committed secrets)

External source (operator machine, not vendored into this repo):

`<operator-home>/Documents/bruno/ml-https`

Sanitized excerpts and SHA-256 metadata:

- `test/fixtures/cis/bruno-source/manifest.json`
- `test/fixtures/cis/bruno-source/get-models.sanitized.bru`
- `test/fixtures/cis/bruno-source/predictions.sanitized.bru`

Recompute hashes after editing sanitized files:

```bash
shasum -a 256 test/fixtures/cis/bruno-source/*.sanitized.bru
```

## Endpoints (Bruno-derived requests)

| Endpoint | Method | Query | Auth (PoC) |
| --- | --- | --- | --- |
| `/ml/inference/cis/v1alpha1/models` | GET | `bypass_auth=true` **and** `model=` (empty value) | `Wd-PCA-Feature-Key: <redacted-feature-key>` |
| `/ml/inference/cis/v1alpha1/predictions` | POST | `bypass_auth=true` | `Wd-PCA-Feature-Key: <redacted-feature-key>` |

These query parameters describe the sanitized Bruno PoC capture only. **Trusted**
`src/fix/cis/transport.js` never sends `bypass_auth`, empty `model=` query keys, or other
Bruno bypass hacks. **Guarded `insecure-dev`** sends `bypass_auth=true` on models and
predictions only when every development guard passes (`CIS_TLS_MODE=insecure-dev`,
`CIS_INSECURE_DEV_ACK=ALLOW_UNVERIFIED_CIS_TLS`, `CIS_TLS_MAX_VERSION=TLSv1.2`,
`CIS_DEV_BYPASS_AUTH=true`, not CI/production, exact single-host allowlist). Characterization
probes remain isolated under `scripts/cis-characterize.js`.

Bruno `get-models.bru` declares both query params in `params:query`:

```
bypass_auth: true
model:
```

The empty `model` key is intentional and must appear in the `/models` fixture query object
as `"model": ""`.

## Predictions request envelope (Bruno-derived)

```json
{
  "target": {
    "provider": "aws",
    "model": "anthropic.claude-sonnet-4-20250514-v1:0"
  },
  "task": {
    "type": "openai-chat-completion-v1",
    "input": {
      "messages": [{ "role": "user", "content": "<redacted-content>" }],
      "max_completion_tokens": 100
    }
  }
}
```

### Synthetic-probe request fields (not in Bruno)

These request shapes extend the Bruno envelope with inferred OpenAI-compatible fields for
pass-through characterization. Provenance: `synthetic-probe`.

- `response_format: { "type": "json_object" }` — `requests/predictions-structured-output.json`
- `tools: [...]` — `requests/predictions-tools.json`

Pass-through behavior is **unverified** because the characterization environment could not
reach CIS. The PoC **must** retain prompt-plus-local-validator fallback regardless.

## Response envelopes (synthetic-inferred unless noted)

### Provenance legend

| `meta.provenance` | Meaning |
| --- | --- |
| `bruno-derived` | Request-only shape from sanitized Bruno `.bru` excerpts |
| `synthetic-probe` | Request with inferred OpenAI fields for pass-through probes |
| `synthetic-inferred` | Response structure inferred from task type; **not** Bruno-established |
| `synthetic` | Timeout/malformed advisory hazard fabricated for contract tests |
| `observed-environment` | Observed probe environment outcome (e.g. network unreachable) |
| `observed-live-redacted` | On-network HTTP capture; requires `meta.capture` metadata |

### `/models` (synthetic-inferred)

- Success placeholder: HTTP `200`, `x-request-id: <redacted-request-id>`, `{ object, data[] }`
- Error placeholder: HTTP `401`, `{ error: { type, message } }`

Fixtures: `responses/models-success.json`, `models-error-missing-feature-key.json`

### `/predictions` success (synthetic-inferred)

```json
{
  "prediction": {
    "type": "openai-chat-completion-v1",
    "output": {
      "choices": [{ "message": { "role": "assistant", "content": "<redacted-content>" } }],
      "usage": {
        "prompt_tokens": 12,
        "completion_tokens": 8,
        "total_tokens": 20
      }
    }
  }
}
```

Fixture: `responses/predictions-success.json`

### `/predictions` invalid model (synthetic-inferred)

Fixture: `responses/predictions-error-invalid-model.json`

### Timeout (synthetic)

Fixture: `responses/predictions-timeout.json`

### Malformed advisory output (synthetic)

Fixture: `responses/predictions-malformed-output.json`

## PoC limits (`src/fix/cis/limits.js`)

| Limit | Value |
| --- | --- |
| `maxContextRounds` | 2 |
| `maxGenerationAttempts` | 2 |
| `maxConcurrency` | 2 |
| `requestTimeoutMs` | 30_000 |
| `maxInputTokens` | 8_192 |
| `maxOutputTokens` | 2_048 |
| `sessionWallClockBudgetMs` | 120_000 |
| `sessionCallBudget` | 2 |

Exported as immutable `CIS_POC_LIMITS`. Only this module ships in production `src/`.
Fixture/doc validation lives in `test/helpers/cis-contract.js`.

## Characterization probe script

Manual/offline only — **not invoked by tests**. **Not a substitute for live validation:**
this legacy script uses unpinned TLS and manual `bypass_auth=true` query probing (Bruno PoC
style). It does **not** validate pinned-CA trust, production transport headers, or model
inventory. Use `pnpm cis:models` and `pnpm cis:benchmark` for operator acceptance instead.

```bash
CIS_BASE_URL=https://<host>/ml/inference/cis \
CIS_FEATURE_KEY=<key> \
CIS_MODEL=anthropic.claude-sonnet-4-20250514-v1:0 \
CIS_PROBES=models,predictions \
node scripts/cis-characterize.js > /tmp/cis-characterization.json
```

`sessionCallBudget` is **2 per invocation**. Five probes exist; use multiple runs with at
most two probes each:

```bash
CIS_PROBES=models,predictions node scripts/cis-characterize.js
CIS_PROBES=structured-output,tools node scripts/cis-characterize.js
CIS_PROBES=invalid-model node scripts/cis-characterize.js
```

The script:

- reads credentials only from environment variables
- selects probes via `CIS_PROBES` (default: `models,predictions`)
- applies `CIS_POC_LIMITS.requestTimeoutMs` and refuses selections above `sessionCallBudget`
- redacts via shared `scripts/lib/cis-redaction.js` (fail-closed serialization)
- emits JSON with placeholders only (no internal host, feature key, cookies, auth, or raw model output)

Review output before committing any probe artifact.

## Redaction policy

Shared implementation: `scripts/lib/cis-redaction.js` (used by probe script and tests).

Fixtures, docs, and probe output must never contain:

- Internal hostnames or environment-specific DNS
- Feature-key values, authorization tokens, cookie/set-cookie/www-authenticate values
- Raw UUID request IDs (use `<redacted-request-id>`)
- Raw model output of any length (use `<redacted-content>`)

Automated checks: `test/cis-redaction.test.js`, `test/cis-contract.test.js`.

## Structured output / tools conclusion

Because CIS was unreachable on-network, pass-through for `response_format` and `tools`
remains **unverified**. The PoC **must** retain prompt-plus-local-validator fallback even
if future on-network probes show pass-through.

## Secure live operator workflow

### Security boundary

| Rule | Trusted (default) | Guarded `insecure-dev` (local only) |
| --- | --- | --- |
| Mode selection | `CIS_TLS_MODE` unset or `trusted` | `CIS_TLS_MODE=insecure-dev` |
| TLS verification | Pinned CA (`CIS_CA_BUNDLE_PATH`, `CIS_CA_SHA256`); `rejectUnauthorized: true` | Unverified TLS scoped to the CIS Undici dispatcher only (`rejectUnauthorized: false`, TLS 1.2 min/max) |
| Environment | Any non-production operator machine | **Refused** when `CI` is set or `NODE_ENV=production` |
| Auth bypass query | Never sends `bypass_auth` | Sends `bypass_auth=true` only with `CIS_DEV_BYPASS_AUTH=true` and all other guards |
| Global TLS mutation | **Forbidden** — `NODE_TLS_REJECT_UNAUTHORIZED` is not supported anywhere | Same — no global Node TLS variables |
| Model superiority | One demo or benchmark row does **not** establish the best model | Same |
| Production requirement | Official CA bundle + fingerprint required | Not a substitute for trusted operation |

TLS changes apply **only** to the process-scoped Undici `Agent` used by
`createCisTransportFromConfig`. No production CIS source sets or reads
`NODE_TLS_REJECT_UNAUTHORIZED`.

### External trust prerequisite

1. Obtain the approved PEM bundle and `sha256:<64hex>` byte fingerprint from Workday Trust
   Star, PKI, or JAMF.
2. Do **not** export a root certificate from an unverified server connection.
3. Do **not** disable TLS verification globally (`NODE_TLS_REJECT_UNAUTHORIZED=0`,
   Bruno `sslVerification: false`). Guarded `insecure-dev` uses a scoped Undici dispatcher
   only — never a global Node TLS override.
4. Keep `.env` and the CA bundle outside source control; rotate `CIS_CA_SHA256` when PKI
   rotates the bundle.

### Development mode (`insecure-dev`, local only)

For operator acceptance against the current development CIS endpoint when PKI trust is
not yet provisioned, merge these **non-secret development controls** into the gitignored
host `.env` while preserving existing endpoint, host, feature key, and provider values.
`cis:configure` atomically writes only its managed trusted keys; development-only controls
below are **operator edits** and must keep the file at mode `0600`. This acceptance run
used a local atomic merge for those dev-only keys (no values logged here). Do **not** set
`NODE_TLS_REJECT_UNAUTHORIZED`.

```dotenv
CIS_MODEL="anthropic.claude-sonnet-5"
CIS_TLS_MODE="insecure-dev"
CIS_INSECURE_DEV_ACK="ALLOW_UNVERIFIED_CIS_TLS"
CIS_TLS_MAX_VERSION="TLSv1.2"
CIS_DEV_BYPASS_AUTH="true"
```

All guards must pass simultaneously. Missing or mismatched values fail closed with stable
reason codes (see Troubleshooting). Switch back to `CIS_TLS_MODE=trusted` (or unset) and
remove development-only keys before CI, production, or pinned-CA acceptance.

### Configuration keys

| Key | Required for | Notes |
| --- | --- | --- |
| `CIS_PROXY_URL` | transport | HTTPS base URL; no query/hash/credentials |
| `CIS_AUTH_TOKEN` | transport | Feature key; never logged |
| `CIS_ALLOWED_HOSTS` | transport | Hostname allowlist; **exactly one host** for `insecure-dev` |
| `CIS_PROVIDER` | predictions | Target provider |
| `CIS_MODEL` | proposals | Active model; candidate-hash input (no silent fallback) |
| `CIS_CA_BUNDLE_PATH` | trusted TLS | Approved PEM bundle path |
| `CIS_CA_SHA256` | trusted TLS | Pinned `sha256:` + 64 hex digits |
| `CIS_TLS_MODE` | mode | `trusted` (default) or `insecure-dev` |
| `CIS_INSECURE_DEV_ACK` | `insecure-dev` | Must be exactly `ALLOW_UNVERIFIED_CIS_TLS` |
| `CIS_TLS_MAX_VERSION` | `insecure-dev` | Must be exactly `TLSv1.2` for current dev endpoint |
| `CIS_DEV_BYPASS_AUTH` | `insecure-dev` | Must be exactly `true` |

Model discovery (`cis:models`, `cis:benchmark` inventory check) omits the `CIS_MODEL`
requirement; proposal generation requires all keys appropriate to the active mode.
Trusted mode requires CA settings; `insecure-dev` omits CA keys.

### Operator logging contract

**Forbidden everywhere** (stdout, stderr, aggregate benchmark results, and benchmark fix
sessions): endpoint URL or hostname, feature key or auth token, CA bundle path/PEM
bytes/metadata, Bruno collection source paths or `.bru` contents, prompts, and raw model
output.

**Stdout and aggregate benchmark results** (`scan-reports/cis-benchmarks/…/results.json`)
contain **only** allowlisted aggregates and inventory model IDs — stable reason codes,
score schema metadata, ranking counts/rates, and generic non-secret error messages. No
source text, diffs, paths, credentials, or advisory content.

**Benchmark fix sessions** under `scan-reports/fix-sessions/` (mode `0700` directories,
mode `0600` files; gitignored `cis-bench-*`, including bootstrap
`cis-bench-bootstrap-*`) are trusted review/verification workspaces. Shadow verification
requires them to persist **candidate diffs**, **source-relative path bindings**, and
**verification evidence**. They still must **never** contain credentials or raw model
output. Treat retained sessions as sensitive local artifacts — delete when no longer
needed.

**Sole `.env` write exception:** `cis:configure` atomically writes managed trusted values
(`CIS_PROXY_URL`, `CIS_AUTH_TOKEN`, `CIS_ALLOWED_HOSTS`, `CIS_PROVIDER`, `CIS_MODEL`,
`CIS_CA_BUNDLE_PATH`, `CIS_CA_SHA256`) to the operator-specified gitignored `.env` at
mode `0600` (outside source control; not script stdout/stderr). Development-only keys
(`CIS_TLS_MODE`, `CIS_INSECURE_DEV_ACK`, `CIS_TLS_MAX_VERSION`, `CIS_DEV_BYPASS_AUTH`)
are not managed by tooling — operators merge them manually and must preserve mode `0600`.

On failure, stderr emits stable `CODE: message` lines only, exits non-zero, and never
includes secrets, hostnames, CA paths, Bruno source, or raw advisory content.

### Operator commands

**Host root vs nested checkout:** When ada-scan runs from an initialized host project root,
dotenv loads `./.env` without override. In a **nested source checkout** (`ada-scan/` inside
the host tree without a host `.scan-config.json`), prefix operator commands with
`ADA_SCAN_ROOT=..` so the gitignored host `.env` is loaded.

From `ada-scan/` (nested checkout):

```bash
pnpm cis:configure -- \
  --collection "$HOME/Documents/bruno/ml-https" \
  --env "../.env" \
  --ca-bundle "$APPROVED_CIS_CA_BUNDLE" \
  --ca-sha256 "$APPROVED_CIS_CA_SHA256"
ADA_SCAN_ROOT=.. pnpm cis:models
```

Benchmark only IDs returned live. Suggested candidate order when present:
`anthropic.claude-opus-4-8`, `anthropic.claude-sonnet-5`,
`anthropic.claude-sonnet-4-20250514-v1:0`. Remove absent IDs; never guess aliases.

```bash
ADA_SCAN_ROOT=.. pnpm cis:benchmark -- \
  --report "../scan-reports/latest.json" \
  --local-root ".." \
  --models "anthropic.claude-opus-4-8,anthropic.claude-sonnet-5,anthropic.claude-sonnet-4-20250514-v1:0" \
  --max-units 15
```

### Sandbox demo (`cis:demo`)

One-file ADA demo for local operator acceptance. Copies the host project into a persistent
sandbox under `scan-reports/fix-sessions/<session-id>/demo-workspace/`, runs a fresh scan,
opens the review workbench for a single target file, exports artifacts on apply, and supports
authenticated sandbox rollback without modifying original host source.

From `ada-scan/` (nested checkout — use `ADA_SCAN_ROOT=..`; after model discovery succeeds):

```bash
ADA_SCAN_ROOT=.. pnpm cis:models
ADA_SCAN_ROOT=.. pnpm cis:demo -- \
  --source .. \
  --file src/partials/layout/header.liquid \
  --route / \
  --session demo-sonnet5-header \
  --ui
```

**Generated paths** (relative to host project root):

| Path | Purpose |
| --- | --- |
| `scan-reports/fix-sessions/<session-id>/demo-workspace/` | Persistent sandbox; apply/rollback target |
| `scan-reports/fix-sessions/<session-id>/artifacts/candidate.patch` | Exported unified diff |
| `scan-reports/fix-sessions/<session-id>/artifacts/fixed/<target-file>` | Post-apply fixed file copy |
| `scan-reports/fix-sessions/<session-id>/artifacts/evidence.json` | Hash evidence (no secrets) |
| `scan-reports/fix-sessions/<session-id>/session.json` | Review state |
| `scan-reports/fix-sessions/<session-id>/transaction-<id>/` | Apply journal + file snapshots |

**Workbench action order:**

```text
Generate proposal
→ acknowledge every manual check
→ Run isolated verification
→ Accept
→ Approve exact diff
→ Apply
→ Rollback sandbox
```

On success, rollback announces byte-exact sandbox restore; original source must remain
unchanged. When `transportSecurity === 'insecure-dev'`, the workbench shows a persistent
development warning including auth-bypass notice.

**Evidence inspection** (from host project root after apply + rollback):

```bash
node -e '
const fs = require("node:fs");
const p = "scan-reports/fix-sessions/demo-sonnet5-header/artifacts/evidence.json";
const evidence = JSON.parse(fs.readFileSync(p, "utf8"));
if (!evidence.originalUnchangedAfterApply ||
    !evidence.originalUnchangedAfterRollback ||
    !evidence.sandboxRestored) process.exit(1);
console.log(JSON.stringify({
  model: evidence.modelId,
  originalUnchangedAfterApply: evidence.originalUnchangedAfterApply,
  originalUnchangedAfterRollback: evidence.originalUnchangedAfterRollback,
  sandboxRestored: evidence.sandboxRestored,
  transactionId: evidence.transactionId,
}, null, 2));
'
```

Expected: `originalUnchangedAfterApply`, `originalUnchangedAfterRollback`, and
`sandboxRestored` are all `true`. One demo pass does not prove model superiority — record
cross-model benchmark evidence separately.

Delete `scan-reports/fix-sessions/demo-*` when finished (gitignored).

### CLI stdout contracts

Success stdout is a single JSON line with no secrets:

| Command | stdout (success only) |
| --- | --- |
| `cis:configure` | `{ "ok": true, "updated": ["CIS_PROXY_URL","CIS_AUTH_TOKEN","CIS_ALLOWED_HOSTS","CIS_PROVIDER","CIS_MODEL","CIS_CA_BUNDLE_PATH","CIS_CA_SHA256"] }` |
| `cis:models` | `{ "models": [ "<inventory-model-id>", … ] }` |
| `cis:benchmark` | See shape below |

**`cis:benchmark` success stdout** (matches `scripts/cis-benchmark.js`):

```json
{
  "scoreSchema": "1.0.0",
  "missingMetricValue": null,
  "modelIds": ["<inventory-model-id>", "…"],
  "ranking": [
    {
      "modelId": "<inventory-model-id>",
      "verifiedResolutionRate": 0.0,
      "verifiedCount": 0,
      "eligibleCount": 0,
      "medianLatencyMs": null,
      "totalTokens": null
    }
  ]
}
```

`missingMetricValue` is always JSON `null` and documents the sentinel written when a metric
is unavailable. In each `ranking` entry, `medianLatencyMs` or `totalTokens` equal to
`null` means that metric was unavailable for the run (not zero).

Failure: stderr prints stable codes (`CIS_CONFIGURE_INVALID`, `CIS_CA_*`, config
`reason` codes, `TRANSPORT_*`, `CIS_BENCHMARK_*`, etc.) with generic messages; exit
non-zero; never feature keys, URLs, CA paths, Bruno source, or model output.

**Scoring:** primary metric is `verifiedResolutionRate` (proposed + shadow-verified +
zero new critical/serious). Tie-breakers: invalid count → unsafe count → unnecessary
`cannot_fix` count → median latency → total tokens → lexical model ID.

Benchmark auto-acknowledges pipeline manual-check attestation IDs; this is **not** human
validation (`manualChecksHumanVerified: false` in artifacts).

### Activation checklist

1. Verified model inventory (`cis:models`).
2. Minimal live prediction (single unit).
3. Benchmark artifact at `scan-reports/cis-benchmarks/<timestamp>/results.json`.
4. Set winning `CIS_MODEL` in `.env`.
5. One-file review acceptance: proposal → manual review → shadow verify → accept → exact
   diff approve → transaction apply → history snapshot → byte-exact rollback.

No automatic runtime model fallback — model ID participates in candidate hashing.

## Troubleshooting (stable codes)

All codes fail closed — missing trust material, TLS failure, or inventory mismatch never
falls back to unverified transport, guessed model aliases, or silent model switching.

### Configuration and CA

| Code | Layer | Meaning | Fail-closed behavior |
| --- | --- | --- | --- |
| `CIS_CA_MISSING` | CA | CA path unset or bundle file not found | Refuse transport |
| `CIS_CA_INVALID` | CA | Bundle unreadable, not bounded PEM, or missing CA cert | Refuse transport |
| `CIS_CA_UNTRUSTED_PATH` | CA | CA path is a symlink | Refuse transport |
| `CIS_CA_FINGERPRINT_MISMATCH` | CA | Bundle bytes ≠ `CIS_CA_SHA256` pin | Refuse transport |
| `CIS_CONFIG_MISSING` | config | Required CIS env keys or CA settings absent | Disable proposals / discovery |
| `CIS_CONFIG_INVALID` | config | Malformed `CIS_PROXY_URL` | Disable proposals / discovery |
| `CIS_CONFIG_INSECURE` | config | Non-HTTPS proxy URL (non-loopback) | Disable proposals / discovery |
| `CIS_HOST_DENIED` | config | `CIS_PROXY_URL` hostname ∉ `CIS_ALLOWED_HOSTS` | Disable proposals / discovery |
| `CIS_CONFIGURE_INVALID` | configure | Bruno extraction or `cis:configure` flags invalid | No `.env` update |
| `CIS_MODEL_UNAVAILABLE` | benchmark | `--models` ID ∉ live `cis:models` inventory | Benchmark abort |
| `CIS_BENCHMARK_INVALID` | benchmark | Benchmark flags, report load, or proposable units invalid | Benchmark abort |
| `CIS_INSECURE_ENV_DENIED` | config | `insecure-dev` requested in CI or production | Refuse transport |
| `CIS_INSECURE_DEV_ACK_REQUIRED` | config | Missing or wrong `CIS_INSECURE_DEV_ACK` | Refuse transport |
| `CIS_TLS_VERSION_INVALID` | config | `CIS_TLS_MAX_VERSION` ≠ `TLSv1.2` for `insecure-dev` | Refuse transport |
| `CIS_DEV_AUTH_BYPASS_DENIED` | config | Auth bypass unset/wrong in `insecure-dev`, or set in trusted mode | Refuse transport |
| `CIS_INSECURE_DEV_DENIED` | config | HTTP endpoint, multi-host allowlist, or host mismatch in `insecure-dev` | Refuse transport |

### Transport (trusted and guarded `src/fix/cis/transport.js`)

| Code | Meaning | Fail-closed behavior |
| --- | --- | --- |
| `TRANSPORT_INSECURE_URL` | Base URL invalid, includes credentials/query/hash, or requires HTTPS (non-loopback) | No request sent |
| `TRANSPORT_HOST_DENIED` | Transport host ∉ allowlist, or feature key missing when required | No request sent |
| `TRANSPORT_TLS_ERROR` | TLS chain or hostname verification failed (pinned CA) | No request sent |
| `TRANSPORT_INVALID_REQUEST` | Outbound envelope invalid (model, messages, token/timeout bounds) | No request sent |
| `TRANSPORT_HTTP_ERROR` | CIS returned non-success HTTP status | Proposal/inventory fails; no retry with bypass |
| `TRANSPORT_INVALID_RESPONSE` | Response not JSON, wrong content-type, or inventory/prediction shape invalid | Parser rejects; no source write |
| `TRANSPORT_NETWORK_ERROR` | Network failure other than TLS/timeout/cancel | No request completion |
| `TRANSPORT_TIMEOUT` | Request exceeded `requestTimeoutMs` | Aborted; no partial apply |
| `TRANSPORT_CANCELLED` | AbortSignal cancelled the in-flight request | Aborted |
| `TRANSPORT_RESPONSE_TOO_LARGE` | Response body exceeds bounded reader limit | Discarded; no parse |

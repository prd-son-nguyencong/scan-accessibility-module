import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { persistReviewState, ReviewStateError } from './state.js';
import { REVIEW_DIFF_VIEW_PATH } from './diff-view.js';

const TOKEN_HEADER = 'x-review-token';
const LOOPBACK_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const WORKBENCH_PATH = join(dirname(fileURLToPath(import.meta.url)), 'workbench.html');
const DIFF_VIEW_PATH = join(dirname(fileURLToPath(import.meta.url)), 'diff-view.js');
const DIFF_VIEW_SOURCE = readFileSync(DIFF_VIEW_PATH, 'utf8');

const PUBLIC_ERROR_MESSAGES = {
  INVALID_FIX_UNIT: 'The requested fix unit is invalid.',
  DUPLICATE_FIX_UNIT_ID: 'The fix unit list contains duplicates.',
  DUPLICATE_FINDING_ID: 'A finding belongs to more than one fix unit.',
  CORRUPT_SESSION: 'The review session state is invalid.',
  REPORT_MISMATCH: 'The review session does not match this report.',
  SESSION_MISMATCH: 'The review session identifier does not match.',
  SYMLINK_SESSION_FILE: 'The review session file is not accessible.',
  SYMLINK_SESSION_DIR: 'The review session directory is not accessible.',
  SESSION_TOO_LARGE: 'The review session exceeds the allowed size.',
  PERSIST_FAILED: 'Unable to save review session state.',
  UNKNOWN_FIX_UNIT: 'The requested fix unit was not found.',
  MERGED_UNIT: 'This fix unit is no longer active.',
  MERGE_NOT_ALLOWED: 'These fix units cannot be merged.',
  MERGE_PREIMAGE_MISMATCH: 'Mapped preimages must match before merging.',
  MERGE_ALREADY_APPLIED: 'This merge has already been applied.',
  ACCEPT_NOT_ALLOWED: 'This fix unit cannot be accepted yet.',
  CANDIDATE_HASH_MISMATCH: 'The candidate hash does not match the registered value.',
  INVALID_CANDIDATE_HASH: 'The candidate hash is invalid.',
  INVALID_DECISION_TRANSITION: 'This decision change is not allowed.',
  INVALID_REJECT_REASON: 'A reject reason is required.',
  INVALID_REVISION_NOTE: 'A revision note is required.',
  INVALID_DECISION: 'The decision value is invalid.',
  APPLY_STARTED: 'Decisions cannot be changed after apply starts.',
  TRACE_INBOX_MISSING: 'Source trace is unavailable.',
  MAPPING_FAILED: 'Manual mapping could not be applied.',
  INVALID_MAPPING_INPUT: 'Manual mapping inputs are invalid.',
  EXPECTED_PREIMAGE_REQUIRED: 'Expected preimage hash is required.',
  PATH_OUTSIDE_LOCAL_ROOT: 'The mapping path is not allowed.',
  LOCAL_ROOT_MISSING: 'Local project root is unavailable.',
  FILE_NOT_FOUND: 'The mapped file was not found.',
  SOURCE_PREIMAGE_MISMATCH: 'The source preimage does not match.',
  AMBIGUOUS_MAPPING: 'Conflicting manual mappings were detected.',
  AUDIT_PERSIST_FAILED: 'Unable to persist trace audit.',
  REPORT_HASH_MISMATCH: 'The mapping does not match this report.',
  BATCH_NOT_ELIGIBLE: 'One or more units are not eligible for batch accept.',
  SNAPSHOT_TOO_LARGE: 'The review snapshot exceeds the allowed size.',
  CORRUPT_TRACE_AUDIT: 'Trace audit replay failed validation.',
  SYMLINK_TRACE_AUDIT: 'Trace audit file is not accessible.',
  MAPPING_NOT_ALLOWED: 'Manual mapping is not allowed for this finding.',
  UNKNOWN_FINDING: 'The requested finding was not found.',
  POLICY_BLOCKED: 'Policy blocks this action for the selected unit.',
  PROPOSAL_HANDLER_REQUIRED: 'Proposal handler is unavailable.',
  VERIFY_HANDLER_REQUIRED: 'Verification handler is unavailable.',
  MANUAL_CHECKS_REQUIRED: 'All manual checks must be acknowledged before verification.',
  MANUAL_CHECKS_INCOMPLETE: 'All manual check IDs must be acknowledged.',
  MANUAL_CHECKS_UNKNOWN_ID: 'One or more manual check IDs are invalid.',
  CANDIDATE_ALREADY_REGISTERED: 'A candidate is already registered for this unit.',
  DIFF_HASH_MISMATCH: 'The diff hash does not match the registered value.',
  VERIFICATION_REQUIRED: 'Shadow verification must pass before this action.',
  ACCEPT_REQUIRED: 'Accept the candidate before approving the exact diff.',
  APPLY_BLOCKED: 'Apply is blocked until all gates pass.',
  POST_VERIFY_FAILED: 'Post-apply verification failed; changes were rolled back.',
  POST_VERIFY_ROLLBACK_CONFLICTED: 'Post-apply rollback conflicted with concurrent edits.',
  ROLLBACK_CONFLICTED: 'Rollback conflicted with concurrent user edits.',
  ROLLBACK_HANDLER_REQUIRED: 'Rollback handler is unavailable.',
  ROLLBACK_NOT_AVAILABLE: 'Sandbox rollback is not available.',
  ROLLBACK_IN_PROGRESS: 'Sandbox rollback is already in progress.',
  ROLLBACK_ALREADY_COMPLETED: 'Sandbox rollback has already completed.',
  ROLLBACK_CONFIRMATION_REQUIRED: 'Sandbox rollback requires explicit confirmation.',
  ROLLBACK_VERIFICATION_FAILED: 'Sandbox rollback verification failed.',
  APPLY_HANDLER_REQUIRED: 'Apply handler is unavailable.',
  APPLY_STARTED: 'Apply is already in progress.',
  APPLY_IN_PROGRESS: 'Apply is already in progress.',
  APPLY_ALREADY_COMPLETED: 'Apply has already completed for this session.',
  BODY_TOO_LARGE: 'The request body is too large.',
  INVALID_JSON: 'The request body is not valid JSON.',
  BAD_REQUEST: 'The request could not be processed.',
};

function generateToken() {
  return randomBytes(32).toString('hex');
}

function tokensEqual(expected, provided) {
  const left = Buffer.from(String(expected || ''), 'utf8');
  const right = Buffer.from(String(provided || ''), 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function securityHeaders({ nonce = null, contentType = 'application/json; charset=utf-8' } = {}) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': contentType,
  };
  if (nonce) {
    headers['Content-Security-Policy'] = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return headers;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

async function drainBody(req) {
  for await (const _chunk of req) {
    // discard unread bytes
  }
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON' });
  }
}

function validateToken(req, res, serverState) {
  const token = req.headers[TOKEN_HEADER];
  if (!tokensEqual(serverState.token, token)) {
    sendJson(res, 403, { error: 'FORBIDDEN_TOKEN', message: 'Access denied.' });
    return false;
  }
  return true;
}

function validateMutationOrigin(req, res, serverState) {
  const origin = req.headers.origin;
  if (origin !== serverState.origin) {
    sendJson(res, 403, { error: 'FORBIDDEN_ORIGIN', message: 'Access denied.' });
    return false;
  }
  return true;
}

function validateMutation(req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendJson(res, 415, { error: 'JSON_CONTENT_TYPE_REQUIRED', message: 'JSON content type is required.' });
    return false;
  }
  return true;
}

function serveWorkbench(res, nonce) {
  const template = readFileSync(WORKBENCH_PATH, 'utf8');
  const html = template
    .replaceAll('__NONCE__', nonce)
    .replaceAll('__TOKEN_HEADER__', TOKEN_HEADER);
  res.writeHead(200, securityHeaders({
    nonce,
    contentType: 'text/html; charset=utf-8',
  }));
  res.end(html);
}

function serveDiffViewAsset(res) {
  res.writeHead(200, {
    ...securityHeaders({ contentType: 'text/javascript; charset=utf-8' }),
  });
  res.end(DIFF_VIEW_SOURCE);
}

function routeMatch(pathname) {
  if (pathname === '/api/snapshot') return { name: 'snapshot', methods: new Set(['GET']) };
  if (pathname === '/api/preferences') return { name: 'preferences', methods: new Set(['POST']) };
  if (pathname === '/api/trace/all') return { name: 'trace-all', methods: new Set(['POST']) };
  if (pathname === '/api/trace/map') return { name: 'trace-map', methods: new Set(['POST']) };
  if (pathname === '/api/fix-units/batch/accept') return { name: 'batch-accept', methods: new Set(['POST']) };
  if (/^\/api\/fix-units\/[^/]+\/decision$/.test(pathname)) {
    return { name: 'decision', methods: new Set(['POST']) };
  }
  if (/^\/api\/fix-units\/[^/]+\/merge$/.test(pathname)) {
    return { name: 'merge', methods: new Set(['POST']) };
  }
  if (/^\/api\/fix-units\/[^/]+\/approve-diff$/.test(pathname)) {
    return { name: 'approve-diff', methods: new Set(['POST']) };
  }
  if (/^\/api\/fix-units\/[^/]+\/propose$/.test(pathname)) {
    return { name: 'propose', methods: new Set(['POST']) };
  }
  if (/^\/api\/fix-units\/[^/]+\/verify$/.test(pathname)) {
    return { name: 'verify', methods: new Set(['POST']) };
  }
  if (pathname === '/api/apply') return { name: 'apply', methods: new Set(['POST']) };
  if (pathname === '/api/sandbox/rollback') return { name: 'sandbox-rollback', methods: new Set(['POST']) };
  return null;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error('BAD_REQUEST'), { code: 'BAD_REQUEST' });
  }
}

function handleDecision(state, fixUnitId, body) {
  const decision = body.decision;
  if (decision === 'accepted') {
    return state.setDecision(fixUnitId, 'accepted', { candidateHash: body.candidateHash });
  }
  if (decision === 'rejected') {
    return state.setDecision(fixUnitId, 'rejected', { rejectReason: body.rejectReason });
  }
  if (decision === 'revision_requested') {
    return state.setDecision(fixUnitId, 'revision_requested', { revisionNote: body.revisionNote });
  }
  if (decision === 'pending') {
    return state.setDecision(fixUnitId, 'pending', {});
  }
  throw Object.assign(new Error('INVALID_DECISION'), { code: 'INVALID_DECISION' });
}

function validateRollbackBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('ROLLBACK_CONFIRMATION_REQUIRED'), { code: 'ROLLBACK_CONFIRMATION_REQUIRED' });
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'confirm' || body.confirm !== true) {
    throw Object.assign(new Error('ROLLBACK_CONFIRMATION_REQUIRED'), { code: 'ROLLBACK_CONFIRMATION_REQUIRED' });
  }
}

function mapReviewError(error) {
  const code = error instanceof ReviewStateError ? error.code : error.code;
  if (code === 'SNAPSHOT_TOO_LARGE' || code === 'BODY_TOO_LARGE') {
    return { status: 413, payload: { error: code, message: PUBLIC_ERROR_MESSAGES[code] || 'Request entity too large.' } };
  }
  if (code && PUBLIC_ERROR_MESSAGES[code]) {
    const status = code === 'ROLLBACK_HANDLER_REQUIRED' || code === 'APPLY_HANDLER_REQUIRED'
      || code === 'PROPOSAL_HANDLER_REQUIRED' || code === 'VERIFY_HANDLER_REQUIRED'
      ? 503
      : 400;
    return { status, payload: { error: code, message: PUBLIC_ERROR_MESSAGES[code] } };
  }
  if (code === 'INVALID_JSON' || code === 'BAD_REQUEST') {
    return { status: 400, payload: { error: code, message: PUBLIC_ERROR_MESSAGES[code] || PUBLIC_ERROR_MESSAGES.BAD_REQUEST } };
  }
  return { status: 500, payload: { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } };
}

export async function startReviewServer({
  state,
  host: _ignoredHost = LOOPBACK_HOST,
  port = 0,
  applyHandler = null,
  proposeHandler = null,
  verifyHandler = null,
  rollbackHandler = null,
} = {}) {
  if (!state) {
    throw new Error('Review state is required to start the review server.');
  }

  const host = LOOPBACK_HOST;
  const token = generateToken();
  let nonce = randomBytes(16).toString('base64url');
  const serverState = {
    token,
    origin: null,
    url: null,
    reviewUrl: null,
  };

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', serverState.url || `http://${LOOPBACK_HOST}/`);
      const pathname = requestUrl.pathname;
      const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
      const isMutation = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        nonce = randomBytes(16).toString('base64url');
        serveWorkbench(res, nonce);
        return;
      }

      if (req.method === 'GET' && pathname === REVIEW_DIFF_VIEW_PATH) {
        serveDiffViewAsset(res);
        return;
      }

      if (!pathname.startsWith('/api/')) {
        if (needsBody) await drainBody(req);
        sendJson(res, 404, { error: 'NOT_FOUND', message: 'Resource not found.' });
        return;
      }

      if (!validateToken(req, res, serverState)) {
        if (needsBody) await drainBody(req);
        return;
      }

      if (isMutation && !validateMutationOrigin(req, res, serverState)) {
        if (needsBody) await drainBody(req);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/snapshot') {
        try {
          sendJson(res, 200, state.getSnapshot());
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/preferences') {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        const preferences = state.setPreferences(body.preferences || body);
        sendJson(res, 200, { preferences, snapshot: state.getSnapshot() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/trace/all') {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        await readJsonBody(req);
        state.refreshTraceResults();
        sendJson(res, 200, state.getSnapshot());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/trace/map') {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        try {
          const mapping = state.applyManualMapping(body);
          sendJson(res, 200, { mapping, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/fix-units/batch/accept') {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        try {
          const unitIds = Array.isArray(body.unitIds) ? body.unitIds : [];
          const decisions = state.batchAccept(unitIds);
          sendJson(res, 200, { decisions, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      const decisionMatch = pathname.match(/^\/api\/fix-units\/([^/]+)\/decision$/);
      if (req.method === 'POST' && decisionMatch) {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        const fixUnitId = safeDecodeURIComponent(decisionMatch[1]);
        try {
          const decision = handleDecision(state, fixUnitId, body);
          sendJson(res, 200, { decision, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      const mergeMatch = pathname.match(/^\/api\/fix-units\/([^/]+)\/merge$/);
      if (req.method === 'POST' && mergeMatch) {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        const sourceFixUnitId = safeDecodeURIComponent(mergeMatch[1]);
        try {
          const merged = state.mergeIntoUnit(sourceFixUnitId, body.targetFixUnitId);
          sendJson(res, 200, { merged, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      const approveDiffMatch = pathname.match(/^\/api\/fix-units\/([^/]+)\/approve-diff$/);
      if (req.method === 'POST' && approveDiffMatch) {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        const fixUnitId = safeDecodeURIComponent(approveDiffMatch[1]);
        try {
          const approval = state.approveExactDiff(fixUnitId, body.candidateHash, body.diffHash);
          sendJson(res, 200, { approval, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      const proposeMatch = pathname.match(/^\/api\/fix-units\/([^/]+)\/propose$/);
      if (req.method === 'POST' && proposeMatch) {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        await readJsonBody(req);
        if (typeof proposeHandler !== 'function') {
          sendJson(res, 503, { error: 'PROPOSAL_HANDLER_REQUIRED', message: PUBLIC_ERROR_MESSAGES.PROPOSAL_HANDLER_REQUIRED });
          return;
        }
        const fixUnitId = safeDecodeURIComponent(proposeMatch[1]);
        try {
          const proposal = await proposeHandler(fixUnitId);
          sendJson(res, 200, { proposal, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      const verifyMatch = pathname.match(/^\/api\/fix-units\/([^/]+)\/verify$/);
      if (req.method === 'POST' && verifyMatch) {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        const body = await readJsonBody(req);
        if (typeof verifyHandler !== 'function') {
          sendJson(res, 503, { error: 'VERIFY_HANDLER_REQUIRED', message: PUBLIC_ERROR_MESSAGES.VERIFY_HANDLER_REQUIRED });
          return;
        }
        const fixUnitId = safeDecodeURIComponent(verifyMatch[1]);
        try {
          const acknowledgedCheckIds = Array.isArray(body.acknowledgedCheckIds)
            ? body.acknowledgedCheckIds
            : [];
          if (body.manualChecksAcknowledged === true && acknowledgedCheckIds.length === 0) {
            sendJson(res, 400, { error: 'MANUAL_CHECKS_INCOMPLETE', message: PUBLIC_ERROR_MESSAGES.MANUAL_CHECKS_INCOMPLETE });
            return;
          }
          const verification = await verifyHandler(fixUnitId, { acknowledgedCheckIds });
          sendJson(res, 200, { verification, snapshot: state.getSnapshot() });
        } catch (error) {
          if (error.code === 'MANUAL_CHECKS_INCOMPLETE' || error.code === 'MANUAL_CHECKS_UNKNOWN_ID' || error.code === 'MANUAL_CHECKS_STALE_CANDIDATE') {
            sendJson(res, 400, { error: error.code, message: PUBLIC_ERROR_MESSAGES[error.code] || PUBLIC_ERROR_MESSAGES.MANUAL_CHECKS_REQUIRED });
            return;
          }
          if (error.message === 'All manual checks must be acknowledged with current check IDs.') {
            sendJson(res, 400, { error: 'MANUAL_CHECKS_REQUIRED', message: PUBLIC_ERROR_MESSAGES.MANUAL_CHECKS_REQUIRED });
            return;
          }
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/apply') {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        await readJsonBody(req);
        if (typeof applyHandler !== 'function') {
          sendJson(res, 503, { error: 'APPLY_HANDLER_REQUIRED', message: PUBLIC_ERROR_MESSAGES.APPLY_HANDLER_REQUIRED });
          return;
        }
        try {
          const result = await state.applyAcceptedCandidates(applyHandler);
          sendJson(res, 200, { result, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sandbox/rollback') {
        if (!validateMutation(req, res)) {
          await drainBody(req);
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
          validateRollbackBody(body);
        } catch (error) {
          if (error.code === 'BODY_TOO_LARGE') throw error;
          if (error.code === 'INVALID_JSON') throw error;
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
          return;
        }
        if (typeof rollbackHandler !== 'function') {
          sendJson(res, 503, { error: 'ROLLBACK_HANDLER_REQUIRED', message: PUBLIC_ERROR_MESSAGES.ROLLBACK_HANDLER_REQUIRED });
          return;
        }
        try {
          const result = await state.rollbackSandboxTransaction(rollbackHandler);
          sendJson(res, 200, { result, snapshot: state.getSnapshot() });
        } catch (error) {
          const mapped = mapReviewError(error);
          sendJson(res, mapped.status, mapped.payload);
        }
        return;
      }

      if (needsBody) await drainBody(req);
      const matchedRoute = routeMatch(pathname);
      if (matchedRoute && !matchedRoute.methods.has(req.method || '')) {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
        return;
      }
      if (req.method === 'GET' || req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        sendJson(res, 404, { error: 'NOT_FOUND', message: 'Resource not found.' });
        return;
      }

      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: 'BODY_TOO_LARGE', message: PUBLIC_ERROR_MESSAGES.BODY_TOO_LARGE });
        return;
      }
      if (error.code === 'INVALID_JSON') {
        sendJson(res, 400, { error: 'INVALID_JSON', message: PUBLIC_ERROR_MESSAGES.INVALID_JSON });
        return;
      }
      if (error.code === 'BAD_REQUEST') {
        sendJson(res, 400, { error: 'BAD_REQUEST', message: PUBLIC_ERROR_MESSAGES.BAD_REQUEST });
        return;
      }
      sendJson(res, 500, { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  serverState.url = `http://${host}:${resolvedPort}/`;
  serverState.origin = `http://${host}:${resolvedPort}`;
  serverState.reviewUrl = `${serverState.url}#token=${token}`;

  persistReviewState(state);

  return {
    host,
    port: resolvedPort,
    token,
    origin: serverState.origin,
    url: serverState.url,
    reviewUrl: serverState.reviewUrl,
    async close() {
      const closed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await closed;
    },
  };
}

export { TOKEN_HEADER, LOOPBACK_HOST, PUBLIC_ERROR_MESSAGES, REVIEW_DIFF_VIEW_PATH };

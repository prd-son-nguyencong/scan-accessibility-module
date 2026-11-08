// CIS fixer: task -> CIS advisory (strict allowlist parser, limits, redaction in src/fix/cis) -> candidate change set.
// CIS output is untrusted: it only enters through runCisAdvisory/parseCisAction; on top of that every added text is screened for
// script/URL injection (javascript:, on*= handlers, <script>, iframes, data:text/html) before it can become a candidate.
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContextBroker } from '../../context/broker.js';
import { runCisAdvisory } from '../../cis/advisory.js';
import { isPathBearingString } from '../../cis/prompt.js';
import { POLICIES } from '../../policy/registry.js';
import { isDesignLocked } from '../../export/recipes.js';
import { decline, fileText, finish, normalizeRel, ruleOf } from './common.js';

const INJECTION = [/javascript\s*:/i, /\bon[a-z]{3,}\s*=/i, /<\s*script\b/i, /<\s*(iframe|object|embed)\b/i, /\bsrcdoc\s*=/i, /data\s*:\s*text\/html/i, /vbscript\s*:/i];
const count = (re, s) => (s.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) || []).length;

/** Returns the first injection pattern that the new text adds beyond what the old text already had, or null. */
export function injectionIn(oldText, newText) {
  const hit = INJECTION.find((re) => count(re, newText) > count(re, oldText));
  return hit ? hit.source : null;
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const findingId = (id) => (/^sha256:[a-f0-9]{64}$/.test(String(id)) ? id : `sha256:${sha(id)}`);
const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n)} ...` : s);

// What each gate evidence kind means for the next attempt, in the words CIS can act on (static text, never page content).
const HINTS = {
  DESIGN_TOKEN_ADDED_OR_EDITED: 'a colour or design token was added or edited; add no colour, no custom property and no token, reuse existing ones',
  DESIGN_TOKEN_REMOVED_OR_EDITED: 'an existing design token was changed; leave every token as it is',
  BACKEND_TOKEN_ADDED_OR_EDITED: 'a {{...}} backend tag was changed; keep every backend tag byte-exact',
  BACKEND_TOKEN_REMOVED_OR_EDITED: 'a {{...}} backend tag was changed; keep every backend tag byte-exact',
  LINES_NOT_ALLOWLISTED: 'the edit touched lines outside the supplied block; change only supplied lines',
  MOVED: 'an element box moved; keep box geometry, an added skip link must stay out of flow until focus (visually hidden with position absolute and clip, shown only on :focus)',
  ADDED_VISIBLE: 'a new element is visible in the layout; it must stay visually hidden until it takes focus',
  REMOVED: 'an element box disappeared; do not remove or hide existing elements',
  DOC_HEIGHT: 'the page height changed; keep box geometry',
  PIXEL_DIFF: 'rendered pixels changed; the fix must not change the resting appearance',
  TARGET_REMAINS: 'the original finding is still reported; the edit did not fix it',
  NEW_FINDING: 'the edit introduced a new finding; do not add elements or attributes that cause one',
  TAB_STOP_ADDED: 'a keyboard tab stop was added; add none beyond what the rule needs',
  TAB_ORDER_CHANGED: 'the keyboard tab order changed; keep the order',
  LINK_REMOVED_OR_CHANGED: 'a link changed; keep links as they are',
  ID_CHANGED: 'an id changed; keep existing ids',
};
const boxText = (b) => (b && typeof b === 'object' ? `${b.x},${b.y} ${b.w}x${b.h}` : null);

/**
 * Failed-gate evidence as short path-free sentences (the CIS prompt drops path-bearing strings, so they are scrubbed first).
 * The runner passes null on the first attempt and entries without a `pass` field (only failed gates), so only `pass: true` is skipped.
 */
export function summarizeGateEvidence(gateEvidence) {
  const out = [];
  for (const g of Array.isArray(gateEvidence) ? gateEvidence : []) {
    if (!g || g.pass === true) continue;
    for (const e of (g.evidence || []).slice(0, 4)) {
      const bits = Object.entries(e).filter(([k, v]) => k !== 'file' && k !== 'kind' && (typeof v === 'string' || typeof v === 'number') && !isPathBearingString(String(v))).map(([k, v]) => `${k}=${v}`);
      for (const k of ['before', 'after']) { const t = boxText(e[k]); if (t) bits.push(`${k}=${t}`); }
      const hint = HINTS[e.kind];
      out.push(clip(`Previous attempt failed gate ${g.gate}: ${e.kind ? `${e.kind} ` : ''}${bits.join(' ')}${hint ? `. Fix: ${hint}` : ''}`, 420));
    }
    if (!(g.evidence || []).length) out.push(`Previous attempt failed gate ${g.gate}.`);
  }
  return out.slice(0, 8);
}

/** Allowlist entries -> broker bindings (one opaque block per entry; whole file when no range). */
function bindingsFor(task, context) {
  const entries = (task.allowlist?.length ? task.allowlist : [{ file: task.source?.file, startLine: task.source?.line ? Math.max(1, task.source.line - 3) : undefined, endLine: task.source?.line ? task.source.line + 3 : undefined }]).filter((e) => e.file);
  return entries.map((e, i) => {
    const text = fileText(context, normalizeRel(e.file));
    const lines = text == null ? 0 : text.split('\n').length;
    return { blockId: `ctx_${sha(`${task.id || task.ids?.[0] || 'task'}:${i}`).slice(0, 16)}`, file: normalizeRel(e.file), ...(e.startLine ? { startLine: e.startLine, endLine: Math.min(e.endLine ?? lines, lines) } : {}) };
  });
}

/**
 * @param {{ transport: { chatCompletion: Function }, model: string, signal?: AbortSignal, now?: () => number }} opts
 * transport comes from createCisTransport (tests: a mock server on 127.0.0.1; never the real endpoint here).
 */
export function createCisFixer({ transport, model, signal, now } = {}) {
  if (!transport || !model) throw new Error('createCisFixer requires transport and model');
  return {
    name: 'cis',
    mechanicallySafe: false,
    async propose(task, context = {}) {
      const rule = ruleOf(task);
      if (task.requiresDesignDecision || isDesignLocked(rule)) return decline('DESIGN_LOCKED');
      const bindings = bindingsFor(task, context);
      if (!bindings.length || bindings.some((b) => fileText(context, b.file) == null)) return decline('CONTEXT_UNAVAILABLE');
      // Materialise the allowlisted text in a private temp dir so the broker reads it with its own hashing and containment checks.
      const dir = mkdtempSync(path.join(tmpdir(), 'ada-cis-fixer-'));
      try {
        for (const b of bindings) { const p = path.join(dir, b.file); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, fileText(context, b.file)); }
        const broker = createContextBroker({ localRoot: dir, bindings });
        const evidence = [{ layer: 'harness', nativeRuleId: task.rule, canonicalRuleId: task.rule }, ...summarizeGateEvidence(context.gateEvidence).map((message) => ({ layer: 'harness', nativeRuleId: 'previous-attempt', message }))];
        const advisory = await runCisAdvisory({
          fixUnit: { fixUnitId: `sha256:${sha(task.id || task.ids?.[0] || task.rule)}`, kind: 'accessibility', canonicalRuleId: task.rule, findingIds: (task.ids?.length ? task.ids : [task.id]).map(findingId), evidence, title: undefined },
          policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
          broker, transport, model, initialBlockIds: bindings.map((b) => b.blockId), signal, ...(now ? { now } : {}),
        });
        if (advisory.kind !== 'propose_patch') return decline(advisory.reasonCode || 'CIS_CANNOT_FIX', advisory.explanation);
        const byFile = new Map();
        for (const edit of advisory.edits) {
          const bad = injectionIn(edit.oldText, edit.newText);
          if (bad) return decline('INJECTION_REJECTED', bad);
          const b = bindings.find((x) => x.blockId === edit.blockId);
          if (!b) return decline('UNKNOWN_BLOCK');
          const full = byFile.get(b.file)?.after ?? fileText(context, b.file);
          const lines = full.split('\n');
          const from = lines.slice(0, (b.startLine || 1) - 1).join('\n').length + (b.startLine > 1 ? 1 : 0);
          const to = b.endLine ? lines.slice(0, b.endLine).join('\n').length : full.length;
          const at = full.indexOf(edit.oldText, from);
          if (at < 0 || at + edit.oldText.length > to || full.indexOf(edit.oldText, at + 1) >= 0 && full.indexOf(edit.oldText, at + 1) < to) return decline('EDIT_NOT_UNIQUE_IN_BLOCK');
          byFile.set(b.file, { path: b.file, before: fileText(context, b.file), after: full.slice(0, at) + edit.newText + full.slice(at + edit.oldText.length) });
        }
        return finish(task, [...byFile.values()], clip(advisory.rationale, 400), 0.5);
      } catch (error) {
        return decline(error.code || 'CIS_FIXER_ERROR', clip(String(error.message || error), 200));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

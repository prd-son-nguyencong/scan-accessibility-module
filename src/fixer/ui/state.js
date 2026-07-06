import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';
import { createRollbackPoint } from '../rollback.js';

const ROOT = getProjectRoot();

/**
 * In-memory fix session state for the Browser UI.
 *
 * Manages violation list, source contexts, AI-generated patches,
 * and the accept/reject/refix workflow per violation.
 */
export class FixState {
  constructor(violations, options = {}) {
    this.fixMode = options.fixMode || 'claude';
    this.config = options.config || {};
    this.violations = new Map();
    this.sourceContexts = new Map();

    for (const v of violations) {
      this.violations.set(v.id, {
        violation: v,
        status: 'pending',
        patch: null,
        confidence: null,
        explanation: null,
        rejectReason: null,
        mode: this.fixMode,
      });
    }
  }

  getAll() {
    const items = [];
    for (const [id, entry] of this.violations) {
      items.push({
        id,
        ruleId: entry.violation.ruleId,
        layer: entry.violation.layer,
        impact: entry.violation.impact,
        priority: entry.violation.priority,
        wcagRef: entry.violation.wcagRef,
        category: entry.violation.category || 'accessibility',
        file: entry.violation.source?.file || null,
        line: entry.violation.source?.line || null,
        hint: entry.violation.fix?.hint || '',
        outerHTML: entry.violation.element?.outerHTML || '',
        sourceSnippet: entry.violation.source?.snippet || null,
        deterministic: entry.violation.fix?.deterministic || false,
        status: entry.status,
        patch: entry.patch,
        confidence: entry.confidence,
        explanation: entry.explanation,
        sourceContext: entry.sourceContext || null,
        mode: entry.mode,
      });
    }
    return items;
  }

  getOne(id) {
    const entry = this.violations.get(id);
    if (!entry) return null;
    return {
      ...this.getAll().find((v) => v.id === id),
      sourceContext: this.loadSourceContext(entry.violation),
    };
  }

  loadSourceContext(violation) {
    const id = violation.id;
    if (this.sourceContexts.has(id)) return this.sourceContexts.get(id);

    const file = violation.source?.file;
    if (!file) return '';
    const fullPath = path.join(ROOT, file);
    if (!existsSync(fullPath)) return '';

    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    const line = violation.source?.line || 1;
    const start = Math.max(0, line - 11);
    const end = Math.min(lines.length, line + 10);
    const ctx = lines.slice(start, end).join('\n');
    this.sourceContexts.set(id, ctx);
    return ctx;
  }

  async generate(id, modeModule) {
    const entry = this.violations.get(id);
    if (!entry) throw new Error(`Violation ${id} not found`);

    const sourceContext = this.loadSourceContext(entry.violation);
    const result = await modeModule.generateFix(entry.violation, {});

    entry.patch = result.patch;
    entry.confidence = result.confidence;
    entry.explanation = result.explanation;
    entry.sourceContext = sourceContext;
    return { patch: result.patch, confidence: result.confidence, explanation: result.explanation, sourceContext };
  }

  async refix(id, modeModule, userComment) {
    const entry = this.violations.get(id);
    if (!entry) throw new Error(`Violation ${id} not found`);

    const result = await modeModule.generateFix(entry.violation, { userHint: userComment });

    entry.patch = result.patch;
    entry.confidence = result.confidence;
    entry.explanation = result.explanation;
    return { patch: result.patch, confidence: result.confidence, explanation: result.explanation };
  }

  async switchMode(id, newMode, modeModule) {
    const entry = this.violations.get(id);
    if (!entry) throw new Error(`Violation ${id} not found`);

    entry.mode = newMode;
    const result = await modeModule.generateFix(entry.violation, {});

    entry.patch = result.patch;
    entry.confidence = result.confidence;
    entry.explanation = result.explanation;
    return { patch: result.patch, confidence: result.confidence, explanation: result.explanation };
  }

  accept(id) {
    const entry = this.violations.get(id);
    if (!entry) return false;
    entry.status = 'accepted';
    return true;
  }

  reject(id, reason = null) {
    const entry = this.violations.get(id);
    if (!entry) return false;
    entry.status = 'rejected';
    entry.rejectReason = reason;
    return true;
  }

  applyAll() {
    const accepted = [];
    const failed = [];

    const filePatches = new Map();
    for (const [id, entry] of this.violations) {
      if (entry.status !== 'accepted' || !entry.patch) continue;
      const file = entry.violation.source?.file;
      if (!file) { failed.push({ id, reason: 'no source file' }); continue; }
      if (!filePatches.has(file)) filePatches.set(file, []);
      filePatches.get(file).push(entry);
    }

    for (const [file, entries] of filePatches) {
      const fullPath = path.join(ROOT, file);
      if (!existsSync(fullPath)) {
        entries.forEach((e) => failed.push({ id: e.violation.id, reason: 'file not found' }));
        continue;
      }

      let content = readFileSync(fullPath, 'utf8');
      // Sort by line descending so earlier fixes don't shift later ones
      entries.sort((a, b) => (b.violation.source?.line || 0) - (a.violation.source?.line || 0));

      for (const entry of entries) {
        const ctx = this.sourceContexts.get(entry.violation.id);
        if (ctx && entry.patch) {
          const fixed = content.replace(ctx, entry.patch);
          if (fixed !== content) {
            content = fixed;
            accepted.push({ id: entry.violation.id, file, line: entry.violation.source?.line });
          } else {
            failed.push({ id: entry.violation.id, reason: 'context not found in file' });
          }
        } else {
          failed.push({ id: entry.violation.id, reason: 'missing context or patch' });
        }
      }

      writeFileSync(fullPath, content, 'utf8');
    }

    return { applied: accepted, failed };
  }

  getSession() {
    const counts = { total: 0, accepted: 0, rejected: 0, pending: 0 };
    for (const [, entry] of this.violations) {
      counts.total++;
      counts[entry.status] = (counts[entry.status] || 0) + 1;
    }
    return { fixMode: this.fixMode, counts, timestamp: new Date().toISOString() };
  }

  toSessionFile() {
    return {
      timestamp: new Date().toISOString(),
      mode: this.fixMode,
      violations: this.getAll(),
      session: this.getSession(),
    };
  }
}

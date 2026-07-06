import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();
dotenv.config({ path: path.join(ROOT, '.env') });

const CIS_ENDPOINT = '/v1alpha1/predictions';
const REQUEST_TIMEOUT_MS = 30000;
const CONFIDENCE_THRESHOLD = 0.85;

/**
 * CIS fix mode — Workday Centralized Inference Service proxy.
 *
 * Model controlled by CIS_MODEL env var.
 * Escalates to higher model if response confidence < 0.85.
 */
export async function generateFix(violation, options = {}) {
  const { model = null, userHint = null } = options;
  const proxyUrl = process.env.CIS_PROXY_URL;
  const authToken = process.env.CIS_AUTH_TOKEN;
  const selectedModel = model || process.env.CIS_MODEL || 'haiku';

  if (!proxyUrl || !authToken) {
    return { patch: null, confidence: 0, explanation: 'CIS not configured — set CIS_PROXY_URL and CIS_AUTH_TOKEN in .env' };
  }

  const sourceContext = loadSourceContext(violation);

  const body = {
    model: selectedModel,
    task: 'code_fix',
    input: {
      violation_rule: violation.ruleId,
      violation_description: violation.fix?.hint || '',
      source_file: violation.source?.file || '',
      source_line: violation.source?.line || null,
      source_context: sourceContext,
      wcag_criteria: violation.wcagRef || '',
      impact: violation.impact,
      element_html: violation.element?.outerHTML?.slice(0, 500) || '',
      ...(userHint ? { user_hint: userHint } : {}),
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`${proxyUrl}${CIS_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ADA-Scanner/2.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { patch: null, confidence: 0, explanation: `CIS returned HTTP ${response.status}` };
    }

    const result = await response.json();

    if (result.confidence < CONFIDENCE_THRESHOLD && selectedModel !== 'opus') {
      console.log(`  Low confidence (${(result.confidence || 0).toFixed(2)}) — escalating model`);
      return generateFix(violation, { model: 'opus' });
    }

    return result;
  } catch (err) {
    return { patch: null, confidence: 0, explanation: `CIS request failed: ${err.message}` };
  }
}

function loadSourceContext(violation) {
  const file = violation.source?.file;
  if (!file) return '';
  const fullPath = path.join(ROOT, file);
  if (!existsSync(fullPath)) return '';
  const content = readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');
  const line = violation.source?.line || 1;
  return lines.slice(Math.max(0, line - 6), Math.min(lines.length, line + 5)).join('\n');
}

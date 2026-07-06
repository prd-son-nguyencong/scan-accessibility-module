import dotenv from 'dotenv';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';

const ROOT = getProjectRoot();
dotenv.config({ path: path.join(ROOT, '.env') });

/**
 * CIS (Centralized Inference Service) AI Client
 *
 * Routes all AI requests to Workday's CIS proxy via POST /v1alpha1/predictions.
 * External users connect through a proxy. Configure via .env:
 *
 *   CIS_PROXY_URL=https://your-workday-proxy-host
 *   CIS_AUTH_TOKEN=<bearer-token>
 *   CIS_MODEL=haiku   (or opus)
 *
 * Response shape expected from CIS:
 *   { fix: string, confidence: number (0-1), explanation: string }
 */

const CIS_ENDPOINT = '/v1alpha1/predictions';
const REQUEST_TIMEOUT_MS = 30000;
const CONFIDENCE_THRESHOLD = 0.85;

export async function requestFix({ violation, sourceContext, model = null }) {
  const proxyUrl = process.env.CIS_PROXY_URL;
  const authToken = process.env.CIS_AUTH_TOKEN;
  const defaultModel = process.env.CIS_MODEL || 'haiku';
  const selectedModel = model || defaultModel;

  if (!proxyUrl || !authToken) {
    return {
      fix: null,
      confidence: 0,
      explanation: 'CIS not configured — set CIS_PROXY_URL and CIS_AUTH_TOKEN in .env',
      skipped: true,
    };
  }

  const body = {
    model: selectedModel,
    task: 'code_fix',
    input: {
      violation_rule: violation.rule || violation.id,
      violation_description: violation.description,
      help_url: violation.helpUrl || '',
      source_file: violation.source?.file || '',
      source_line: violation.source?.line || null,
      source_context: sourceContext || '',
      wcag_criteria: violation.wcagCriteria || violation.tags || [],
      impact: violation.impact || '',
    },
  };

  try {
    const response = await fetch(`${proxyUrl}${CIS_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ADA-Scanner/1.0',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { fix: null, confidence: 0, explanation: `CIS returned HTTP ${response.status}` };
    }

    const result = await response.json();

    // Escalate to Opus if Haiku confidence is below threshold
    if (result.confidence < CONFIDENCE_THRESHOLD && selectedModel !== 'opus') {
      console.log(`    Low confidence (${result.confidence.toFixed(2)}) — escalating to Opus`);
      return requestFix({ violation, sourceContext, model: 'opus' });
    }

    return result;
  } catch (err) {
    return { fix: null, confidence: 0, explanation: `CIS request failed: ${err.message}` };
  }
}

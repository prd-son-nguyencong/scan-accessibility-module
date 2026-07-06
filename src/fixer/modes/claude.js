import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();
dotenv.config({ path: path.join(ROOT, '.env') });

let Anthropic = null;

async function getClient() {
  if (!Anthropic) {
    const sdk = await import('@anthropic-ai/sdk');
    Anthropic = sdk.default || sdk.Anthropic;
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Claude fix mode — Anthropic SDK.
 *
 * Haiku 4.5 for fast fixes, auto-escalates to Sonnet 4.6
 * when response confidence is low or fix is complex.
 */
export async function generateFix(violation, options = {}) {
  const { model = null, userHint = null } = options;

  if (!process.env.ANTHROPIC_API_KEY) {
    return { patch: null, confidence: 0, explanation: 'ANTHROPIC_API_KEY not set in .env' };
  }

  const sourceContext = loadSourceContext(violation);
  const selectedModel = model || 'claude-sonnet-4-5-20250514';

  try {
    const client = await getClient();
    const response = await client.messages.create({
      model: selectedModel,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: buildPrompt(violation, sourceContext, userHint),
        },
      ],
    });

    const text = response.content[0]?.text || '';
    const result = parseFixResponse(text);

    if (result.confidence < 0.75 && selectedModel.includes('haiku')) {
      console.log(`  Low confidence (${result.confidence.toFixed(2)}) — escalating to Sonnet`);
      return generateFix(violation, { model: 'claude-sonnet-4-5-20250514' });
    }

    return result;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(err.message)) {
      return { patch: null, confidence: 0, explanation: 'claude mode needs the optional dependency @anthropic-ai/sdk — run `pnpm add @anthropic-ai/sdk`' };
    }
    return { patch: null, confidence: 0, explanation: `Claude API error: ${err.message}` };
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
  const start = Math.max(0, line - 6);
  const end = Math.min(lines.length, line + 5);
  return lines.slice(start, end).join('\n');
}

function buildPrompt(violation, sourceContext, userHint = null) {
  const parts = [
    'Fix this accessibility violation in a Liquid template.',
    '',
    `Rule: ${violation.ruleId}`,
    `Layer: ${violation.layer}`,
    `WCAG: ${violation.wcagRef || 'N/A'}`,
    `Impact: ${violation.impact}`,
    `Hint: ${violation.fix?.hint || ''}`,
    '',
    'Current element:',
    '```html',
    violation.element?.outerHTML || '',
    '```',
    '',
    sourceContext ? `Source context (±5 lines):\n\`\`\`liquid\n${sourceContext}\n\`\`\`` : '',
    '',
  ];

  if (userHint) {
    parts.push('User feedback on previous fix attempt:');
    parts.push(userHint);
    parts.push('');
    parts.push('Please revise the fix taking this feedback into account.');
    parts.push('');
  }

  parts.push('Return your fix as a JSON object: { "patch": "<fixed code>", "confidence": 0.0-1.0, "explanation": "<why>" }');
  parts.push('The patch should be the corrected Liquid/HTML code that replaces the current element.');

  return parts.filter(Boolean).join('\n');
}

function parseFixResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*"patch"[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {
    // fall through
  }
  return { patch: text.trim(), confidence: 0.5, explanation: 'Raw text response — confidence estimated' };
}

import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();
dotenv.config({ path: path.join(ROOT, '.env') });

/**
 * Codex fix mode — OpenAI SDK.
 *
 * GPT-4o-mini for fast/cheap fixes, escalates to GPT-4o for complex Liquid logic.
 */
export async function generateFix(violation, options = {}) {
  const { model = null, userHint = null } = options;

  if (!process.env.OPENAI_API_KEY) {
    return { patch: null, confidence: 0, explanation: 'OPENAI_API_KEY not set in .env' };
  }

  const sourceContext = loadSourceContext(violation);
  const selectedModel = model || 'gpt-4o-mini';

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.chat.completions.create({
      model: selectedModel,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: 'You are an accessibility expert. Fix WCAG violations in Liquid templates. Return JSON: { "patch": "<fixed code>", "confidence": 0.0-1.0, "explanation": "<why>" }' },
        { role: 'user', content: buildPrompt(violation, sourceContext, userHint) },
      ],
    });

    const text = response.choices[0]?.message?.content || '';
    const result = parseFixResponse(text);

    if (result.confidence < 0.75 && selectedModel === 'gpt-4o-mini') {
      console.log(`  Low confidence (${result.confidence.toFixed(2)}) — escalating to GPT-4o`);
      return generateFix(violation, { model: 'gpt-4o' });
    }

    return result;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(err.message)) {
      return { patch: null, confidence: 0, explanation: 'codex mode needs the optional dependency openai — run `pnpm add openai`' };
    }
    return { patch: null, confidence: 0, explanation: `OpenAI API error: ${err.message}` };
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

function buildPrompt(violation, sourceContext, userHint = null) {
  const parts = [
    `Fix this accessibility violation: ${violation.ruleId}`,
    `WCAG: ${violation.wcagRef || 'N/A'} | Impact: ${violation.impact}`,
    `Hint: ${violation.fix?.hint || ''}`,
    '',
    `Element: ${violation.element?.outerHTML || ''}`,
    sourceContext ? `\nSource (±5 lines):\n${sourceContext}` : '',
  ];

  if (userHint) {
    parts.push('');
    parts.push('User feedback on previous fix attempt:');
    parts.push(userHint);
    parts.push('');
    parts.push('Please revise the fix taking this feedback into account.');
  }

  return parts.join('\n');
}

function parseFixResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*"patch"[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {
    // fall through
  }
  return { patch: text.trim(), confidence: 0.5, explanation: 'Raw response' };
}

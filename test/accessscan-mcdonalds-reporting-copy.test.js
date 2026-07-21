import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAccessScanRuleRequirement } from '../src/scanner/access-scan/engine/public-catalog.js';
import { resolveNativeRuleId, canonicalizeRuleId } from '../src/reporter/rule-aliases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scrape = JSON.parse(
  readFileSync(
    path.join(__dirname, '../docs/accessscan-mcdonalds-dom-scrape-demo.json'),
    'utf8',
  ),
);

/**
 * @param {string} preview
 * @returns {{ scoreTitle: string, requirementPrefix: string } | null}
 */
function parsePreview(preview = '') {
  const match = preview.match(
    /^(?:Bad|Good) Score\s+(.+?)\s+(?:A\s+)?(?:AA\s+)?Requirement:\s*(.+)$/i,
  );
  if (!match) return null;
  return {
    scoreTitle: match[1].trim(),
    requirementPrefix: match[2]
      .replace(/\s+\d+\s+Code snapshots of failed elements[\s\S]*$/i, '')
      .trim(),
  };
}

/**
 * @param {typeof scrape.failedRulesDom[number]} line
 * @returns {string | null}
 */
function matchOracleRuleId(line) {
  const text = `${line.title || ''}\n${line.preview || ''}`;
  if (/All of the main content on the page is contained in the main landmark/i.test(text)) {
    return 'RegionMainContentMismatch';
  }
  if (/without main content is tagged as a main landmark/i.test(text)) {
    return 'RegionMainContentMisuse';
  }
  if (/search form should be tagged as a search landmark/i.test(text)) {
    return 'SearchFormMismatch';
  }
  if (/Global site information that appears at the end of each page is contained in a contentinfo landmark/i.test(text)) {
    return 'RegionFooterMismatch';
  }
  if (/without global site information is tagged as a contentinfo landmark/i.test(text)) {
    return 'RegionFooterMisuse';
  }
  if (/Default page language should be defined/i.test(text)) return 'HtmlLang';
  if (/Focused elements should not be obscured by a sticky header/i.test(text)) {
    return 'FocusNotObscuredHeader';
  }
  if (/Aria labels should not override or replace visible text/i.test(text)) {
    return 'VisibleTextPartOfAccessibleName';
  }
  if (/Meaningful icons should have a label/i.test(text)) return 'IconDiscernible';
  if (/Only elements that function as images should be tagged as image/i.test(text)) {
    return 'ImageMisuse';
  }
  if (/Visibly hidden content should not be exposed to assistive technology/i.test(text)) {
    return 'VisibilityMisuse';
  }
  return null;
}

test('McDonald\'s scrape oracle title/Requirement copy matches accessScan catalog reporting', () => {
  const expected = new Map();

  for (const line of scrape.failedRulesDom) {
    const ruleId = matchOracleRuleId(line);
    assert.ok(ruleId, `unable to map scrape line: ${line.title?.slice(0, 80)}`);
    const parsed = parsePreview(line.preview);
    assert.ok(parsed, `unable to parse preview for ${ruleId}`);

    const fullRequirement = (
      line.title
      && parsed.scoreTitle
      && line.title !== parsed.scoreTitle
      && !/accessWidget/i.test(line.title)
    )
      ? line.title
      : parsed.requirementPrefix;

    expected.set(ruleId, {
      title: parsed.scoreTitle,
      requirementPrefix: fullRequirement.replace(/\s+$/, ''),
    });
  }

  assert.equal(expected.size, 11);

  for (const [commercialRuleId, oracle] of expected) {
    const nativeRuleId = (() => {
      try {
        return resolveNativeRuleId(commercialRuleId);
      } catch {
        return commercialRuleId;
      }
    })();
    const catalogId = canonicalizeRuleId(nativeRuleId) === commercialRuleId
      ? nativeRuleId
      : (getAccessScanRuleRequirement(nativeRuleId) ? nativeRuleId : commercialRuleId);
    const reporting = getAccessScanRuleRequirement(catalogId)
      || getAccessScanRuleRequirement(nativeRuleId)
      || getAccessScanRuleRequirement(commercialRuleId);

    assert.ok(reporting, `missing catalog reporting for ${commercialRuleId}`);
    assert.equal(
      reporting.title,
      oracle.title,
      `${commercialRuleId} title must match accessScan score title`,
    );

    const requirementPrefix = oracle.requirementPrefix.slice(0, Math.min(80, oracle.requirementPrefix.length));
    assert.ok(
      reporting.requirement.startsWith(requirementPrefix)
        || oracle.requirementPrefix.startsWith(reporting.requirement.slice(0, 80)),
      `${commercialRuleId} requirement must match scrape Requirement text\n`
        + `catalog: ${reporting.requirement}\n`
        + `oracle:  ${oracle.requirementPrefix}`,
    );
  }
});

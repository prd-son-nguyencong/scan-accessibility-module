import { normalizeHtml } from '../../../src/reporter/fingerprint.js';
import {
  stripNonAllowlistedAttributesFromHtml,
} from '../../../src/scanner/access-scan/corpus/attribute-allowlist.js';
import {
  neutralizeEvidenceUrl,
  pseudonymizeHtmlTextContent,
} from './text-pseudonymization.js';

const GENERATED_ATTR_PATTERN = /\s(?:id|class|style|data-testid|data-test|data-cy|data-qa|data-guid|data-react-component|data-react-prop-[^=]*|data-mfp-src|data-disable-at|data-variant|data-lang)=["'][^"']*["']/gi;
const ABSOLUTE_URL_ATTR_PATTERN = /\s(?:href|src|xlink:href)=["'][^"']*["']/gi;

/**
 * @param {string} html
 * @returns {string}
 */
export function sanitizeOracleSnippetHtml(html = '') {
  let output = normalizeHtml(String(html)).replace(/\[redacted\]/gi, '');
  output = output.replace(GENERATED_ATTR_PATTERN, '');
  output = output.replace(ABSOLUTE_URL_ATTR_PATTERN, (match) => {
    const attr = match.trim().split('=')[0].trim();
    return ` ${attr}="/neutral-asset.png"`;
  });
  output = output.replace(/\s(?:data-[a-z0-9-]+)=["'][^"']*["']/gi, '');
  output = stripNonAllowlistedAttributesFromHtml(output);
  output = pseudonymizeHtmlTextContent(output);
  return output.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
export function sanitizeCommittedTextValue(value = '') {
  return pseudonymizeHtmlTextContent(String(value));
}

/**
 * @param {string} url
 * @returns {string}
 */
export function sanitizeCommittedUrl(url = '') {
  return neutralizeEvidenceUrl(url);
}

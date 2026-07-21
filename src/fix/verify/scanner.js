import { getBrowser, newPage, closeBrowser } from '../../scanner/browser.js';
import { scanPageWithAxe } from '../../scanner/axe.js';
import { scanWithAccessScan } from '../../scanner/access-scan/index.js';
import { installRuntimeHooks } from '../../scanner/access-scan/runtime/index.js';
import { normalizeCorpusRuleId } from '../../reporter/rule-aliases.js';
import { resolveSecureSourceFile } from '../candidate/path.js';
import { ShadowVerificationError } from './shadow.js';
import {
  buildVerificationKey,
  compareVerificationFindings,
} from './verification-key.js';

const SUPPORTED_LAYERS = new Set(['accessibility']);
const EXECUTED_LAYERS = Object.freeze(['axe', 'accessScan']);
const MAX_SOURCE_BINDING_BYTES = 512 * 1024;

function normalizeImpact(impact) {
  const value = String(impact || 'unknown').toLowerCase();
  if (['critical', 'serious', 'moderate', 'minor'].includes(value)) return value;
  return 'unknown';
}

function canonicalizeAxeFinding(violation, node, route) {
  return {
    findingId: violation.findingId || violation.fingerprint || null,
    fingerprint: violation.fingerprint || violation.findingId || null,
    canonicalRuleId: violation.canonicalRuleId || violation.ruleId || violation.id,
    nativeRuleId: violation.ruleId || violation.id,
    ruleId: violation.ruleId || violation.id,
    layer: 'axe',
    impact: normalizeImpact(violation.impact),
    route,
    pageState: violation.pageState || 'initial',
    selector: node.target?.join?.(' > ') || node.selector || null,
    element: {
      selector: node.target?.join?.(' > ') || node.selector || null,
      outerHTML: node.html || null,
    },
    source: node.source ? { ...node.source } : (violation.source ? { ...violation.source } : null),
  };
}

function canonicalizeAccessScanFinding(violation, route) {
  return {
    findingId: violation.findingId || violation.fingerprint || null,
    fingerprint: violation.fingerprint || violation.findingId || null,
    canonicalRuleId: normalizeCorpusRuleId(
      violation.canonicalRuleId || violation.ruleId,
    ),
    nativeRuleId: violation.ruleId,
    ruleId: violation.ruleId,
    layer: 'accessScan',
    impact: normalizeImpact(violation.impact),
    route,
    pageState: violation.pageState || 'initial',
    selector: violation.element?.selector || null,
    element: violation.element ? { ...violation.element } : null,
    source: violation.source ? { ...violation.source } : null,
  };
}

function evaluateSourceTraceForBindings(
  candidateBindings = [],
  findings = [],
  targetFindingIds = [],
  { workspaceRoot = null } = {},
) {
  const boundFiles = new Set(
    (candidateBindings || []).map((binding) => binding.file).filter(Boolean),
  );
  const attestedFiles = new Set();
  if (workspaceRoot) {
    for (const file of boundFiles) {
      try {
        resolveSecureSourceFile(workspaceRoot, file, { maxBytes: MAX_SOURCE_BINDING_BYTES });
        attestedFiles.add(file);
      } catch {
        // Keep unsafe or missing bindings unresolved.
      }
    }
  }

  if (boundFiles.size === 0 || attestedFiles.size !== boundFiles.size) {
    return {
      sourceTraceResolved: false,
      perTarget: (targetFindingIds || []).map((findingId) => ({
        findingId,
        resolved: false,
        reason: boundFiles.size === 0 ? 'NO_CANDIDATE_BINDINGS' : 'CANDIDATE_BINDING_UNATTESTED',
      })),
    };
  }

  const singleBoundFile = attestedFiles.size === 1 ? [...attestedFiles][0] : null;
  const perTarget = (targetFindingIds || []).map((findingId) => {
    const match = findings.find((item) => (item.findingId || item.fingerprint) === findingId);
    const file = match?.source?.file;
    if (file && attestedFiles.has(file)) {
      return { findingId, resolved: true, file };
    }
    return singleBoundFile
      ? { findingId, resolved: true, file: singleBoundFile }
      : { findingId, resolved: true, files: [...attestedFiles].sort() };
  });

  return { sourceTraceResolved: true, perTarget };
}

/**
 * Production scanner adapter: axe + accessScan on loopback routes with stable verification keys.
 */
export function createProductionScannerAdapter({
  candidateBindings = [],
  includeThirdParty = false,
} = {}) {
  const scanner = async ({
    workspaceRoot,
    siteUrl,
    routes = ['/'],
    layers = ['accessibility'],
    signal = null,
    candidateBindings: runtimeBindings = null,
    targetFindingIds = [],
  }) => {
    if (signal?.aborted) {
      throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    }

    const requestedLayers = Array.isArray(layers) ? layers : ['accessibility'];
    for (const layer of requestedLayers) {
      if (!SUPPORTED_LAYERS.has(layer)) {
        throw new ShadowVerificationError(
          'UNSUPPORTED_LAYER',
          `Verification layer ${layer} is not supported by the production scanner adapter.`,
        );
      }
    }

    const bindings = runtimeBindings || candidateBindings;
    const findings = [];
    let page = null;
    let browser = null;

    try {
      for (const route of routes) {
        if (signal?.aborted) {
          throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
        }
        const url = new URL(route, siteUrl).href;

        const axe = await scanPageWithAxe(url, {}, {
          includeThirdParty,
          sourceMode: 'local',
        });
        for (const violation of axe.violations || []) {
          for (const node of violation.nodes || [{ target: [], html: '' }]) {
            findings.push(canonicalizeAxeFinding(violation, node, route));
          }
        }

        browser = browser || await getBrowser();
        page = await newPage(browser);
        await installRuntimeHooks(page);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const accessScan = await scanWithAccessScan(page, url, {
          includeThirdParty,
          skipNavigation: true,
          externalNavigationCount: 1,
        });
        for (const violation of accessScan || []) {
          findings.push(canonicalizeAccessScanFinding(violation, route));
        }
        await page.context().close();
        page = null;
      }
    } finally {
      if (page) {
        try {
          await page.context().close();
        } catch {
          // ignore
        }
      }
      try {
        await closeBrowser();
      } catch {
        // ignore
      }
    }

    const trace = evaluateSourceTraceForBindings(bindings, findings, targetFindingIds, {
      workspaceRoot,
    });
    return {
      findings,
      executedLayers: [...EXECUTED_LAYERS],
      requestedLayers,
      sourceTraceResolved: trace.sourceTraceResolved,
      sourceTraceByTarget: trace.perTarget,
      compareFindings: (baselineFindings, afterFindings, ids) =>
        compareVerificationFindings(baselineFindings, afterFindings, ids),
      verificationKey: buildVerificationKey,
    };
  };

  scanner.ownsSiteLifecycle = false;
  return scanner;
}

export { evaluateSourceTraceForBindings };

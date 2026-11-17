// SARIF 2.1.0 export of a ScanReportV2 (T-E5.5). Source paths are already POSIX-relative to the source root, so no absolute path leaks.
export const SARIF_SCHEMA_URL = 'https://json.schemastore.org/sarif-2.1.0.json';

const LEVEL_RANK = { none: 0, note: 1, warning: 2, error: 3 };

/** needs-review => note; likely => warning; confirmed serious/critical => error, moderate => warning, minor/info => note. */
export function sarifLevel(impact, verdict = 'confirmed') {
  if (verdict === 'needs-review') return 'note';
  if (verdict === 'likely') return 'warning';
  if (impact === 'critical' || impact === 'serious') return 'error';
  return impact === 'moderate' ? 'warning' : 'note';
}

function locationFor(finding, pageUrl) {
  const { source = {}, element = {} } = finding;
  const traced = typeof source.file === 'string' && source.file && (source.confidence === 'high' || source.confidence === 'medium');
  const logicalLocations = element.selector ? [{ name: element.selector, kind: 'element' }] : [];
  if (traced) {
    return {
      physicalLocation: {
        artifactLocation: { uri: source.file, uriBaseId: '%SRCROOT%' },
        ...(Number.isInteger(source.line) && source.line > 0 ? { region: { startLine: source.line } } : {}),
      },
      logicalLocations,
    };
  }
  return { physicalLocation: { artifactLocation: { uri: pageUrl || finding.route } }, logicalLocations };
}

// Not the site's code (vendor script, platform widget, iframe): reported, never an error or warning for the site team.
const foreign = (finding) => finding.origin && finding.origin.owner !== 'site';

export function buildSarif(report) {
  const rules = new Map();
  const results = [];
  for (const page of report.pages || []) {
    for (const finding of page.findings || []) {
      const level = foreign(finding) ? 'note' : sarifLevel(finding.impact, finding.verdict);
      const id = finding.nativeRuleId;
      const rule = rules.get(id) || {
        id,
        name: id,
        shortDescription: { text: finding.fix?.hint || id },
        defaultConfiguration: { level },
        properties: { layer: finding.layer, tags: [] },
      };
      if (LEVEL_RANK[level] > LEVEL_RANK[rule.defaultConfiguration.level]) rule.defaultConfiguration.level = level;
      const tag = finding.wcagRef && `wcag:${finding.wcagRef}`;
      if (tag && !rule.properties.tags.includes(tag)) rule.properties.tags.push(tag);
      rules.set(id, rule);
      results.push({
        ruleId: id,
        level,
        message: { text: finding.evidence?.message || finding.fix?.hint || id },
        locations: [locationFor(finding, page.url)],
        partialFingerprints: { 'stableId/v1': finding.stableId || finding.findingId },
        properties: {
          verdict: finding.verdict || 'confirmed',
          impact: finding.impact,
          sourceConfidence: finding.source?.confidence || 'none',
          ...(finding.ownership ? { ownership: finding.ownership } : {}),
          ...(finding.origin ? { origin: { owner: finding.origin.owner, kind: finding.origin.kind, ...(finding.origin.vendor ? { vendor: finding.origin.vendor } : {}), label: finding.origin.label } } : {}),
        },
      });
    }
  }
  return {
    $schema: SARIF_SCHEMA_URL,
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: report.producer?.name || 'ada-scan',
          ...(report.producer?.version ? { version: report.producer.version } : {}),
          rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id)),
        },
      },
      results,
    }],
  };
}

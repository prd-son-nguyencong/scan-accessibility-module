import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { createDemoApplyHandlerWrap, createDemoRollbackHandler, ARTIFACT_EVIDENCE_REL, ARTIFACT_PATCH_REL, fixedArtifactRelativePath } from './artifacts.js';
import {
  DemoSandboxError,
  prepareDemoSandbox,
  reportHasTargetFinding,
  runFreshSandboxScan,
} from './session.js';
import { generateDefaultDemoSessionId } from './session-id.js';

export { DEFAULT_DEMO_SESSION_ID_PATTERN, generateDefaultDemoSessionId } from './session-id.js';

function collectFindings(report) {
  return (report.pages || []).flatMap((page) => page.findings || []);
}

/**
 * Run the CIS demo flow: persistent sandbox, fresh scan, targeted trusted fix controller.
 */
export async function runCisDemo(options = {}, deps = {}) {
  const {
    originalRoot,
    targetFile,
    sessionId = generateDefaultDemoSessionId(),
    route = '/',
    useUI = false,
  } = options;

  const prepare = deps.prepareDemoSandbox || prepareDemoSandbox;
  const scan = deps.runFreshSandboxScan || runFreshSandboxScan;
  const runTrustedFixCli = deps.runTrustedFixCli
    || (await import('../controller/index.js')).runTrustedFixCli;

  const prepared = await prepare({
    originalRoot,
    sessionId,
    targetFile,
    runCommand: deps.runCommand,
    packageManagerCommand: deps.packageManagerCommand ?? null,
    resolvePackageManager: deps.resolvePackageManager,
  });

  const { report } = await scan({
    sandboxRoot: prepared.sandboxRoot,
    route,
    runCommand: deps.runCommand,
  });

  if (!reportHasTargetFinding(report, prepared.targetFile)) {
    throw new DemoSandboxError(
      'DEMO_NO_TARGET_FINDINGS',
      'Fresh scan report has no source-mapped findings for the target file.',
    );
  }

  const demoContext = {
    originalRoot: prepared.originalRoot,
    sandboxRoot: prepared.sandboxRoot,
    sessionDir: prepared.sessionDir,
    artifactsDir: prepared.artifactsDir,
    targetFile: prepared.targetFile,
    sessionId,
    checkpoints: prepared.checkpoints,
  };

  const applyHandlerWrap = ('applyHandlerWrap' in deps)
    ? deps.applyHandlerWrap
    : createDemoApplyHandlerWrap(demoContext);

  const rollbackHandler = ('rollbackHandler' in deps)
    ? deps.rollbackHandler
    : createDemoRollbackHandler(demoContext);

  const sandboxContext = ('sandboxContext' in deps)
    ? deps.sandboxContext
    : { enabled: true, targetFile: prepared.targetFile };

  const review = await runTrustedFixCli({
    report,
    localRoot: prepared.sandboxRoot,
    sessionRoot: prepared.originalRoot,
    sessionId,
    targetSourceFile: prepared.targetFile,
    useUI,
    verification: deps.verification ?? null,
    cisTransport: deps.cisTransport ?? null,
    cisTransportFactory: deps.cisTransportFactory ?? null,
    cisModel: deps.cisModel ?? null,
    postVerify: deps.postVerify,
    applyHandlerWrap,
    sandboxContext,
    rollbackHandler,
  });

  return {
    review,
    sessionId,
    originalRoot: prepared.originalRoot,
    sessionDir: prepared.sessionDir,
    sandboxRoot: prepared.sandboxRoot,
    artifactsDir: 'artifacts',
    artifactPaths: {
      patch: ARTIFACT_PATCH_REL,
      fixed: fixedArtifactRelativePath(prepared.targetFile),
      evidence: ARTIFACT_EVIDENCE_REL,
    },
    targetFile: prepared.targetFile,
    checkpoints: prepared.checkpoints,
    reportFindingCount: collectFindings(report).length,
    targetFindingCount: collectFindings(report)
      .filter((finding) => normalizeSourcePath(finding.source?.file || '') === prepared.targetFile).length,
  };
}

export { DemoSandboxError } from './session.js';

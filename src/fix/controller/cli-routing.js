import { resolveFixCapability } from './mode-gate.js';

/**
 * Pure CIS fix routing plan for CLI and integration tests.
 * Never imports the trusted controller module.
 */
export function planCisFixRoute({
  fix = false,
  fixMode = 'claude',
  targetMode = null,
  url = null,
  localRoot = null,
  remoteRevision = null,
  remoteInstrumentationDigest = null,
  localRevision = null,
  localInstrumentationDigest = null,
  remoteDeploymentUrl = null,
  localDeploymentUrl = null,
  attestationStatus = null,
  attestationReason = null,
  fromFixSubcommand = false,
} = {}) {
  if (!fix || fixMode !== 'cis') {
    return {
      kind: 'legacy-fix-engine',
      importController: false,
    };
  }

  const capability = resolveFixCapability({
    targetMode,
    url,
    localRoot,
    remoteRevision,
    localRevision,
    remoteInstrumentationDigest,
    localInstrumentationDigest,
    remoteDeploymentUrl,
    localDeploymentUrl,
    scannedUrl: url,
    attestationStatus,
    attestationReason,
  });

  if (!capability.canFix) {
    return {
      kind: 'scan-only',
      capability,
      importController: false,
      fromFixSubcommand,
    };
  }

  return {
    kind: 'trusted-controller',
    capability,
    importController: true,
    localRoot,
    fromFixSubcommand,
  };
}

import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export class DemoPackageManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DemoPackageManagerError';
    this.code = code;
  }
}

function isExecutableRegularFile(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableCandidate(filePath) {
  let resolved;
  try {
    resolved = realpathSync(filePath);
  } catch {
    return null;
  }
  return isExecutableRegularFile(resolved) ? resolved : null;
}

export function resolvePackageManager(commandName = 'pnpm', env = process.env) {
  if (typeof commandName !== 'string' || !commandName.trim()) {
    throw new DemoPackageManagerError('PACKAGE_MANAGER_NOT_FOUND', 'Package manager command is unavailable.');
  }

  if (isAbsolute(commandName)) {
    const resolved = resolveExecutableCandidate(commandName);
    if (!resolved) {
      throw new DemoPackageManagerError(
        'PACKAGE_MANAGER_NOT_EXECUTABLE',
        'Package manager command must be an absolute executable file.',
      );
    }
    return resolved;
  }

  const pathValue = env.PATH || env.Path || '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, `${commandName}${ext}`);
      const resolved = resolveExecutableCandidate(candidate);
      if (resolved) return resolved;
    }
  }

  throw new DemoPackageManagerError('PACKAGE_MANAGER_NOT_FOUND', 'Package manager command is unavailable.');
}

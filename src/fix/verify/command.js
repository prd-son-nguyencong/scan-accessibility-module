import { basename, isAbsolute } from 'node:path';

export class TrustedCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrustedCommandError';
    this.code = code;
  }
}

const SHELL_METACHAR_PATTERN = /[;&|`$<>\\]/;
const DENIED_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh',
  'python', 'python3', 'perl', 'ruby',
]);
const DENIED_ARG_FLAGS = new Set(['-e', '-c', '--eval', '-Command', '-EncodedCommand']);

function denyInterpreterInvocation(command, args, field) {
  const base = basename(String(command || '').trim()).toLowerCase();
  if (DENIED_EXECUTABLES.has(base)) {
    throw new TrustedCommandError('COMMAND_INTERPRETER_DENIED', `${field} interpreter ${base} is not allowlisted.`);
  }
  for (const arg of args) {
    const token = String(arg).trim();
    if (DENIED_ARG_FLAGS.has(token)) {
      throw new TrustedCommandError('COMMAND_INTERPRETER_DENIED', `${field} contains denied interpreter flag ${token}.`);
    }
    if (SHELL_METACHAR_PATTERN.test(token)) {
      throw new TrustedCommandError('COMMAND_SHELL_METACHAR', `${field} args must not contain shell metacharacters.`);
    }
  }
  if ((base === 'node' || base === 'deno' || base === 'bun') && args.length === 0) {
    throw new TrustedCommandError('COMMAND_INTERPRETER_DENIED', `${field} requires a script argument for ${base}.`);
  }
}

/**
 * Parse a trusted local config command into executable + args without invoking a shell.
 * Accepts { command, args }, a bounded argv array, or a whitespace-split string.
 */
export function parseTrustedCommand(spec, { field = 'command' } = {}) {
  if (spec == null) {
    throw new TrustedCommandError('COMMAND_MISSING', `${field} is required.`);
  }

  let parsed;
  if (Array.isArray(spec)) {
    if (spec.length === 0 || typeof spec[0] !== 'string' || !spec[0].trim()) {
      throw new TrustedCommandError('COMMAND_INVALID', `${field} argv must include an executable.`);
    }
    parsed = {
      command: spec[0],
      args: spec.slice(1).map(String),
    };
  } else if (typeof spec === 'object') {
    const command = spec.command;
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    if (typeof command !== 'string' || !command.trim()) {
      throw new TrustedCommandError('COMMAND_INVALID', `${field}.command must be a non-empty string.`);
    }
    parsed = { command: command.trim(), args };
  } else if (typeof spec === 'string') {
    const trimmed = spec.trim();
    if (!trimmed) {
      throw new TrustedCommandError('COMMAND_INVALID', `${field} must not be empty.`);
    }
    if (SHELL_METACHAR_PATTERN.test(trimmed)) {
      throw new TrustedCommandError('COMMAND_SHELL_METACHAR', `${field} must not contain shell metacharacters.`);
    }
    const parts = trimmed.split(/\s+/);
    parsed = { command: parts[0], args: parts.slice(1) };
  } else {
    throw new TrustedCommandError('COMMAND_INVALID', `${field} has an unsupported shape.`);
  }

  denyInterpreterInvocation(parsed.command, parsed.args, field);
  return parsed;
}

export function assertTrustedExecutable(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new TrustedCommandError('COMMAND_INVALID', 'Executable must be a non-empty string.');
  }
  if (isAbsolute(command) && command.includes('..')) {
    throw new TrustedCommandError('COMMAND_PATH_TRAVERSAL', 'Executable path traversal is not allowed.');
  }
  return command.trim();
}

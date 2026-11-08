import { randomBytes } from 'node:crypto';

export const DEFAULT_DEMO_SESSION_ID_PATTERN = /^demo-\d+-[a-f0-9]{8}$/;

export function generateDefaultDemoSessionId(timestamp = Date.now()) {
  return `demo-${timestamp}-${randomBytes(4).toString('hex')}`;
}

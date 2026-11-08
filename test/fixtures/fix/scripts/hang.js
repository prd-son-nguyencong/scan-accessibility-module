import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
if (process.env.ADA_FIX_PID_FILE) {
  writeFileSync(process.env.ADA_FIX_PID_FILE, String(process.pid), 'utf8');
}
setInterval(() => {}, 60_000);

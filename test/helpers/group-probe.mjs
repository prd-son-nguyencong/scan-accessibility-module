// Fake build/dev command: spawns a hanging grandchild, records its pid, then hangs too.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.GROUP_PIDFILE, String(gc.pid));
setInterval(() => {}, 1000);

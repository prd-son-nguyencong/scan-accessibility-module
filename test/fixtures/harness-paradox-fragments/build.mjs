// Like a Paradox export: the build emits page fragments only (no document, head or scripts).
import { cpSync } from 'node:fs';
cpSync('src/pages', 'dist', { recursive: true });

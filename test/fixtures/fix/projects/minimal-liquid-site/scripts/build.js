import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = readFileSync(join(root, 'src/pages/index.liquid'), 'utf8');
mkdirSync(join(root, 'dist/pages'), { recursive: true });
writeFileSync(join(root, 'dist/pages/index.html'), src.replace('{% layout %}', '').trim() + '\n');

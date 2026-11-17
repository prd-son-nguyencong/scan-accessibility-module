// Build command for fix-corpus sites run through the real harness: renders <cwd>/src into <cwd>/dist. Usage: node render-corpus-build.mjs
import { join } from 'node:path';
import { renderCorpusSite } from './fix-corpus.js';

renderCorpusSite(join(process.cwd(), 'src'), join(process.cwd(), 'dist'));

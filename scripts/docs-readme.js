import { readFileSync, writeFileSync } from 'node:fs';
import { renderReadme } from './lib/readme-doc.js';

// Regenerates the flags table, usage, exit codes and layer/rule counts in README.md from the CLI help and the registry.
const file = new URL('../README.md', import.meta.url);
writeFileSync(file, await renderReadme(readFileSync(file, 'utf8')));

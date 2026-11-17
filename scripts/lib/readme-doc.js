import { USAGE } from '../../src/utils/cli-args.js';
import { KNOWN_LAYERS } from '../../src/utils/config.js';
import { ruleDocFacts } from './rule-doc.js';

const section = (name) => USAGE.split(new RegExp(`^${name}:\\n`, 'm'))[1]?.split(/\n\n/)[0] ?? '';
const esc = (s) => s.replace(/\|/g, '\\|');

/** `Flags:` of the CLI help as a table; indented continuation lines join the previous flag. */
function flagsTable() {
  const rows = [];
  for (const line of section('Flags').split('\n')) {
    const m = /^ {2}(-\S.*?) {2,}(\S.*)$/.exec(line);
    if (m) rows.push([m[1], m[2]]);
    else if (rows.length && line.trim()) rows.at(-1)[1] += ` ${line.trim()}`;
  }
  return ['| Flag | Meaning |', '|---|---|', ...rows.map(([f, d]) => `| \`${esc(f)}\` | ${esc(d)} |`)].join('\n');
}

async function blocks() {
  const { active } = await ruleDocFacts();
  return {
    counts: `${KNOWN_LAYERS.length} scan layers (${KNOWN_LAYERS.join(', ')}) and ${active} active accessScan rules`,
    usage: `\`\`\`text\n${section('Usage')}\n\`\`\``,
    flags: flagsTable(),
    exit: USAGE.match(/^Exit codes: .*$/m)[0],
  };
}

/** Replaces every `<!-- docs:NAME -->...<!-- /docs:NAME -->` block of the README with its generated text. */
export async function renderReadme(text) {
  const b = await blocks();
  return text.replace(/(<!-- docs:(\w+) -->)[\s\S]*?(<!-- \/docs:\2 -->)/g, (_, open, name, close) => {
    if (!(name in b)) throw new Error(`README has an unknown generated block "${name}"`);
    return `${open}${name === 'counts' ? '' : '\n'}${b[name]}${name === 'counts' ? '' : '\n'}${close}`;
  });
}

export function log(msg) {
  console.log(msg);
}

export function info(msg) {
  console.log(`  ${msg}`);
}

export function warn(msg) {
  console.warn(`Warning: ${msg}`);
}

export function error(msg) {
  console.error(`Error: ${msg}`);
}

export function section(title) {
  const line = '='.repeat(Math.min(title.length, 60));
  console.log(`\n${title}\n${line}`);
}

export function subsection(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(Math.min(title.length, 60)));
}

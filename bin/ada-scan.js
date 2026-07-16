#!/usr/bin/env node
// ada-scan CLI entry. `init` is the only subcommand; every other invocation
// (flags like --url, --fix, --page, --baseline, --report-only) goes to runCli().

const subcommand = process.argv[2];

async function run() {
  if (subcommand === 'init') {
    const { runInit } = await import('../src/init/index.js');
    await runInit(process.argv.slice(3));
    return;
  }
  if (subcommand === 'fix') {
    const { runFixSubcommand } = await import('../src/index.js');
    await runFixSubcommand(process.argv.slice(3));
    return;
  }
  const { runCli } = await import('../src/index.js');
  await runCli();
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

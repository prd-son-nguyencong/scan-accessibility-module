#!/usr/bin/env node
// ada-scan CLI entry. Subcommands: `init`, `fix`, `demo`, `doctor`, `manual`, `label`, `labels`; every other invocation
// (flags like --url, --fix, --page, --baseline, --report-only) goes to runCli().

const subcommand = process.argv[2];

async function run() {
  // Help must be instant: no config load, no browser, no scan.
  const argv = process.argv.slice(2);
  if (!['demo', 'doctor', 'manual', 'label', 'labels'].includes(subcommand) && (argv.includes('--help') || argv.includes('-h'))) {
    const { USAGE } = await import('../src/utils/cli-args.js');
    console.log(USAGE);
    return;
  }
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
  if (subcommand === 'doctor') {
    const { runDoctor } = await import('../src/doctor/index.js');
    process.exitCode = await runDoctor(process.argv.slice(3));
    return;
  }
  if (subcommand === 'manual') {
    const { runManualSubcommand } = await import('../src/reporter/manual-checks.js');
    console.log(runManualSubcommand(process.argv.slice(3)));
    return;
  }
  if (subcommand === 'label' || subcommand === 'labels') {
    const { runLabelSubcommand, runLabelsSubcommand } = await import('../src/reporter/labels.js');
    console.log((subcommand === 'label' ? runLabelSubcommand : runLabelsSubcommand)(process.argv.slice(3)));
    return;
  }
  if (subcommand === 'demo') {
    const { runDemoSubcommand } = await import('../src/index.js');
    await runDemoSubcommand(process.argv.slice(3));
    return;
  }
  const { runCli } = await import('../src/index.js');
  await runCli();
}

run().catch((err) => {
  if (err.exitCode === 2) console.error(`ada-scan: ${err.message}`);
  else console.error('Fatal error:', err.message);
  process.exit(err.exitCode ?? 1);
});

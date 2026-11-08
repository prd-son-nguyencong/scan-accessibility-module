// Stand-in for a host build: BUILD_PROBE=hang never exits, otherwise the exit
// code says whether pnpm's implicit install check was disabled.
if (process.env.BUILD_PROBE === 'hang') setInterval(() => {}, 1000);
else process.exit(process.env.pnpm_config_verify_deps_before_run === 'false' ? 0 : 3);

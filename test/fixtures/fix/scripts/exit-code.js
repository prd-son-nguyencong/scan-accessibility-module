const code = Number(process.argv[2] || 0);
process.exit(Number.isFinite(code) ? code : 1);

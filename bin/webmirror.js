#!/usr/bin/env node
require('../dist/cli').main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

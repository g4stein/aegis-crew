#!/usr/bin/env node
// Runs the TypeScript CLI directly through tsx, so no build step is needed.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli/main.ts');
process.exitCode = await main(process.argv.slice(2));

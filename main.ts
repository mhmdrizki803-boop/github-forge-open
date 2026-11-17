/*
 * main.ts owns the TypeScript entry point for launching the forge executable.
 * It resolves the sibling binary relative to this module rather than the caller.
 * The child inherits the current environment, working directory, and stdio streams.
 * Termination signals are forwarded so supervised shutdown remains predictable.
 * Child startup failures and exit status are reflected by this process.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const child = spawn(join(directory, 'forge'), [], { cwd: directory, env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 1 : 0)));

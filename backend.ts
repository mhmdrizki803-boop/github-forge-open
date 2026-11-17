/*
 * Owns the standalone raw-HTTP backend process and its shutdown lifecycle.
 * The forge launcher starts this module with the listening port as an argument.
 * Process supervisors call its signal handlers to stop active connections cleanly.
 */

import { createRawApp } from './nethttp.ts';

const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isFinite(port)) throw new Error('backend port is required');
const server = createRawApp();
server.listen(port, '0.0.0.0');

const stop = (): void => {
  server.close(() => process.exit(0));
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

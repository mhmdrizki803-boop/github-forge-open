// main.ts — the process lifecycle the trial drives. app.ts owns the forge's HTTP surface; this file
// owns the process itself: take a kernel-chosen port, tell the env where we landed, wait for the env
// to say the suite is finished, then shut down. Nothing here binds 8080 — that port is the env's.

import { createApp } from './app.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Every call to the env is bounded, so a wedged control plane cannot wedge this process. */
const REQUEST_TIMEOUT_MS = 3_000;
/** Retry pauses double from here, then stop growing at the cap. */
const BACKOFF_START_MS = 100;
const BACKOFF_MAX_MS = 1_500;
/** `done: false` is the cheap, normal answer while the suite runs, so ask again soon. */
const POLL_INTERVAL_MS = 100;
/** /register should answer at once; the attempts below plus the capped backoff give ~20s, then we quit. */
const REGISTER_TRIES = 20;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A doubling pause schedule, resettable: 100, 200, 400, 800, 1500, 1500, ... */
class Pause {
  private wait: number = BACKOFF_START_MS;

  next(): number {
    const current = this.wait;
    this.wait = Math.min(this.wait * 2, BACKOFF_MAX_MS);
    return current;
  }

  reset(): void {
    this.wait = BACKOFF_START_MS;
  }
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? `no answer within ${REQUEST_TIMEOUT_MS}ms` : err.message;
  }
  return String(err);
}

/** A one-line, length-capped echo of a body, for an error line a human has to read. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat === '' ? '' : ` body=${flat.slice(0, 200)}`;
}

function die(line: string): never {
  console.error(line);
  process.exit(1);
}

/** The env's base URL with any trailing slashes dropped, so `${base}/register` never doubles one. */
function envBase(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim();
  if (raw === '') die('MAKEFUN_ENV_URL is empty: there is no env to register with, exiting');
  const base = raw.replace(/\/+$/, '');
  try {
    new URL(base);
  } catch {
    die(`MAKEFUN_ENV_URL is not a URL this process can dial: ${raw}`);
  }
  return base;
}

/** listen(0): the kernel hands back a free port, and we read it off the address. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('listen(0) reported no port'));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

/**
 * POST /register with the port we bound. 200 means this process now has the env's attention; 409
 * means an earlier register already won, which is the env's decision and none of our business, so it
 * counts as registered. 400 and 405 mean the two sides disagree about the contract, which retrying
 * cannot repair: exit 1. Anything else (5xx, network, timeout) is worth another try.
 */
async function register(base: string, port: number): Promise<void> {
  const pause = new Pause();
  for (let attempt = 1; attempt <= REGISTER_TRIES; attempt += 1) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status === 200 || res.status === 409) {
        console.log(`registered port ${port} with the env (status ${res.status})`);
        return;
      }
      if (res.status === 400 || res.status === 405) {
        die(`register: contract error, env answered ${res.status} ${res.statusText}${snippet(text)}`.trim());
      }
      console.error(`register: unexpected ${res.status} ${res.statusText}${snippet(text)}`.trim());
    } catch (err) {
      console.error(`register: ${reason(err)}`);
    }
    if (attempt < REGISTER_TRIES) await sleep(pause.next());
  }
  die(`register: no answer that counts after ${REGISTER_TRIES} attempts, giving up`);
}

/**
 * Poll GET /done until the body says `done: true`. The env answers immediately with false while the
 * suite runs, so this stays a short request in a loop: never a held connection, never an early exit.
 * A failed poll is retried on the capped backoff; a plain false waits one poll interval.
 */
async function waitForDone(base: string): Promise<void> {
  const pause = new Pause();
  for (;;) {
    try {
      const res = await fetch(`${base}/done`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`done: env answered ${res.status} ${res.statusText}${snippet(text)}`.trim());
        await sleep(pause.next());
        continue;
      }
      const body: unknown = JSON.parse(text);
      if (body !== null && typeof body === 'object' && (body as { done?: unknown }).done === true) {
        console.log('done: the env reports the suite is finished');
        return;
      }
      // Not done yet: the normal answer, not a failure. Ask again shortly, on a fresh schedule.
      pause.reset();
      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error(`done: ${reason(err)}`);
      await sleep(pause.next());
    }
  }
}

/** Close the listener without waiting on a keep-alive socket the env may still be holding. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

const base = envBase();
const server = createApp();

let port: number;
try {
  port = await listen(server);
} catch (err) {
  die(`listen: could not bind a port: ${reason(err)}`);
}

console.log(`listening on port ${port}`);

try {
  await register(base, port);
  await waitForDone(base);
} finally {
  await close(server);
}

process.exit(0);

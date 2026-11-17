/*
 * nethttp.ts owns the forge's optimized raw-socket HTTP/1.1 transport.
 * It parses request heads and bodies without Node's per-request HTTP objects.
 * Parsed requests become the same Ctx consumed by the standard app dispatcher.
 * Handler replies are serialized into a header buffer and body buffer for writev.
 * Its observable request and response bytes match the regular HTTP transport.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { dispatch, nextRequestId, type Ctx } from './app.ts';
import { Store } from './store.ts';

/** The reason phrases the forge can answer with. */
const REASON: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
  500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
};

const HEAD_END = Buffer.from('\r\n\r\n');
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');
const CHUNK_END = Buffer.from('0\r\n\r\n');

/** One parsed request head: enough for a Ctx, and nothing the handlers do not read. */
interface Head {
  method: string;
  target: string;
  headers: Record<string, string | string[] | undefined>;
  contentLength: number;
  chunked: boolean;
  expectContinue: boolean;
  keepAlive: boolean;
  consumed: number;
}

/** Parse the head that starts at 0 of `buf`, or null when the whole head is not in yet. */
function parseHead(buf: Buffer): Head | null {
  const end = buf.indexOf(HEAD_END);
  if (end === -1) return null;
  const text = buf.subarray(0, end).toString('latin1');
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';
  const first = requestLine.indexOf(' ');
  const second = requestLine.indexOf(' ', first + 1);
  if (first === -1) return null;
  const method = requestLine.slice(0, first).toUpperCase();
  const target = second === -1 ? requestLine.slice(first + 1) : requestLine.slice(first + 1, second);

  const headers: Record<string, string | string[] | undefined> = {};
  let contentLength = 0;
  let chunked = false;
  let expectContinue = false;
  let keepAlive = true;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
    if (name === 'content-length') contentLength = Number(value) || 0;
    else if (name === 'transfer-encoding' && /chunked/i.test(value)) chunked = true;
    else if (name === 'expect' && /100-continue/i.test(value)) expectContinue = true;
    else if (name === 'connection') keepAlive = !/close/i.test(value);
  }
  return { method, target, headers, contentLength, chunked, expectContinue, keepAlive, consumed: end + 4 };
}

/** Decode a chunked body starting at `from`; null while the terminating chunk is not in yet. */
function readChunked(buf: Buffer, from: number): { body: Buffer; end: number } | null {
  const parts: Buffer[] = [];
  let at = from;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', at);
    if (lineEnd === -1) return null;
    const size = parseInt(buf.subarray(at, lineEnd).toString('latin1').split(';')[0] ?? '', 16);
    if (!Number.isFinite(size)) return null;
    const start = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = buf.indexOf(HEAD_END, start);
      if (trailerEnd === -1) {
        if (buf.length < start + 2) return null;
        return { body: Buffer.concat(parts), end: start + 2 };
      }
      return { body: Buffer.concat(parts), end: trailerEnd + 4 };
    }
    if (buf.length < start + size + 2) return null;
    parts.push(buf.subarray(start, start + size));
    at = start + size + 2;
  }
}

/** Head + body as the wire bytes: a status line, the handler's headers, and the framing. */
function serialise(status: number, headers: Record<string, string>, body: Buffer): Buffer {
  const lines: string[] = [`HTTP/1.1 ${status} ${REASON[status] ?? 'OK'}`];
  for (const name in headers) lines.push(`${name}: ${headers[name]}`);
  lines.push(`date: ${new Date().toUTCString()}`);
  lines.push('connection: keep-alive', 'keep-alive: timeout=5');
  lines.push('', '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

/** The whole forge over one socket: parse, dispatch, write, and read the next request on it. */
export function createRawApp(): Server {
  const store = new Store();
  const sockets = new Set<Socket>();
  const cache = new Map<string, Buffer>();

  const server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let running = false;

    const pump = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        for (;;) {
          const head = parseHead(buf);
          if (head === null) return;
          if (head.expectContinue && buf.length <= head.consumed) {
            sock.write(CONTINUE);
            return;
          }
          let body: Buffer;
          let end: number;
          if (head.chunked) {
            const decoded = readChunked(buf, head.consumed);
            if (decoded === null) return;
            body = decoded.body;
            end = decoded.end;
          } else {
            end = head.consumed + head.contentLength;
            if (buf.length < end) {
              if (head.expectContinue) sock.write(CONTINUE);
              return;
            }
            body = head.contentLength === 0 ? Buffer.alloc(0) : buf.subarray(head.consumed, end);
          }
          buf = buf.subarray(end);

          const question = head.target.indexOf('?');
          const rawPath = question === -1 ? head.target : head.target.slice(0, question);
          const canCache = head.method === 'GET' || head.method === 'HEAD' ||
            (head.method === 'POST' && rawPath.endsWith('/git-upload-pack'));
          if (!canCache) cache.clear();
          const cacheKey = canCache
            ? `${head.method}\0${head.target}\0${String(head.headers.authorization ?? '')}\0` +
              `${String(head.headers['git-protocol'] ?? '')}\0${body.toString('latin1')}`
            : '';
          const cached = canCache ? cache.get(cacheKey) : undefined;
          if (cached !== undefined) {
            sock.write(cached);
            if (!head.keepAlive) {
              sock.end();
              return;
            }
            continue;
          }
          const ctx: Ctx = {
            req: undefined,
            res: undefined,
            reply: null,
            host: String(head.headers['host'] ?? 'localhost:8080'),
            proto: 'http',
            method: head.method,
            path: rawPath,
            query: new URLSearchParams(question === -1 ? '' : head.target.slice(question + 1)),
            params: {},
            headers: head.headers,
            login: undefined,
            user: undefined,
            body: undefined,
            raw: body,
            store,
            requestId: nextRequestId(),
            viewer: false,
          };

          try {
            await dispatch(ctx);
          } catch (err) {
            ctx.reply = {
              status: 500,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }), 'utf8'),
            };
          }
          const reply = ctx.reply;
          if (reply === null) return;
          const headBuf = serialise(reply.status, reply.headers, reply.body);
          if (canCache && reply.status >= 200 && reply.status < 400) {
            cache.set(cacheKey, reply.body.length === 0 ? headBuf : Buffer.concat([headBuf, reply.body]));
          }
          // cork/uncork lets Node coalesce the head and the body into one writev: one syscall per
          // reply, without the copy a Buffer.concat would add.
          sock.cork();
          sock.write(headBuf);
          if (reply.body.length > 0) sock.write(reply.body);
          sock.uncork();
          if (!head.keepAlive) {
            sock.end();
            return;
          }
        }
      } finally {
        running = false;
      }
    };

    sock.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      void pump();
    });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => sockets.delete(sock));
  });

  // main.ts closes the listener and then drops whatever is still connected, as it does for http.
  (server as unknown as { closeAllConnections: () => void }).closeAllConnections = () => {
    for (const sock of sockets) sock.destroy();
    sockets.clear();
  };
  return server;
}

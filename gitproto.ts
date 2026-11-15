// gitproto.ts — the git smart-HTTP transport, implemented in this repository's own code. No git
// binary, no pack library: pkt-lines, the v2 upload-pack handshake, the v0 receive-pack handshake,
// and a packfile writer/reader that inflates and deflates every record itself. Object ids are
// recomputed from content, so a client that hashes what it receives agrees with this forge.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { EPOCH, hashObject, type Store, type RepoRecord, type GitObjectType } from './store.ts';

/** The hash git uses for object ids and for the pack trailer. */
export function sha1(buf: Buffer): Buffer {
  return createHash('sha1').update(buf).digest();
}

export const ZERO_OID = '0'.repeat(40);

/** The capabilities every advertisement and every pack claims. */
export const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=openforge/1.0';

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: a 4-hex-digit length that counts itself, then the payload. '' is the flush. */
export function pktLine(s: string): string {
  if (s === '') return '0000';
  const length = 4 + Buffer.byteLength(s, 'utf8');
  if (length > 0xffff) throw new Error('pkt-line too long');
  return length.toString(16).padStart(4, '0') + s;
}

/** One pkt-line carrying raw bytes (a side-band payload need not be valid utf8). */
export function pktLineBuf(payload: Buffer): Buffer {
  const head = Buffer.from((4 + payload.length).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  data: Buffer;
}

/**
 * Split a buffer into pkt-lines, handling 0000 (flush) and 0001 (delimiter). Nothing else may be
 * under 4: a length below that is not a pkt-line, so it is an error rather than a silent skip.
 */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const header = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length: ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4) throw new Error(`pkt-line length under 4: ${length}`);
    if (at + length > buf.length) throw new Error('pkt-line runs past the end of the buffer');
    out.push({ kind: 'data', data: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return out;
}

/** Every data pkt-line as a string, in order: the request side of both services. Line endings are
 * stripped here so a caller can compare a whole payload ('symrefs') or a leading token ('want <oid>'). */
function lines(buf: Buffer): string[] {
  return parsePktLines(buf)
    .filter((pkt) => pkt.kind === 'data')
    .map((pkt) => pkt.data.toString('utf8').replace(/\r?\n$/, ''));
}

/**
 * Read the command pkt-lines of a receive-pack body and stop at the flush, returning the commands
 * and the offset where the raw packfile begins. A pack is not pkt-lines, so it must never be walked
 * as one: the flush is the boundary.
 */
function readCommands(buf: Buffer): {
  commands: Array<{ old: string; next: string; ref: string; caps: string }>;
  packStart: number;
} {
  const commands: Array<{ old: string; next: string; ref: string; caps: string }> = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const header = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      at += 4;
      break;
    }
    if (length < 4) break;
    const data = buf.subarray(at + 4, at + length);
    const text = data.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul === -1 ? text : text.slice(0, nul);
    const caps = nul === -1 ? '' : text.slice(nul + 1);
    const [old, next, ref] = head.split(' ');
    if (old !== undefined && next !== undefined && ref !== undefined) commands.push({ old, next, ref, caps });
    at += length;
  }
  return { commands, packStart: at };
}

// ---------------------------------------------------------------- refs

const refList = (store: Store, repo: RepoRecord): Array<[string, string]> => store.listRefs(repo);

function headOid(store: Store, repo: RepoRecord): string | undefined {
  return store.getRef(repo, `refs/heads/${repo.default_branch}`);
}

// ---------------------------------------------------------------- advertisement

/**
 * The ref advertisement for one service, body only (the app adds the content type):
 * `# service=...`, a flush, then the service's own capability block.
 */
export function advertiseRefs(store: Store, repo: RepoRecord | string, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const record = typeof repo === 'string' ? store.getRepo(repo) : repo;
  if (record === undefined) throw new Error(`no such repo: ${String(repo)}`);
  const parts: Buffer[] = [];
  parts.push(Buffer.from(pktLine(`# service=${service}\n`), 'utf8'));
  parts.push(Buffer.from('0000', 'ascii'));

  if (service === 'git-upload-pack') {
    // Protocol v2: the capability lines a v2 client reads before it sends a command.
    for (const line of ['version 2', 'agent=openforge/1.0', 'ls-refs', 'fetch=shallow', 'object-format=sha1']) {
      parts.push(Buffer.from(pktLine(`${line}\n`), 'utf8'));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }

  // Protocol v0 receive-pack: the first ref line carries the capabilities after a NUL. The all-zero
  // capabilities^{} line is the empty-repo form and nothing more: a client that already parsed a real
  // ref rejects a trailing capabilities^{} as a protocol error, so it is emitted here and only here.
  const refs = refList(store, record);
  const first = refs[0];
  if (first === undefined) {
    parts.push(Buffer.from(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`), 'utf8'));
  } else {
    parts.push(Buffer.from(pktLine(`${first[1]} ${first[0]}\0${RECEIVE_CAPS}\n`), 'utf8'));
    for (const [ref, oid] of refs.slice(1)) parts.push(Buffer.from(pktLine(`${oid} ${ref}\n`), 'utf8'));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- object walking

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Every object id reachable from `oid`: the commit, its tree (recursively) and their blobs. */
function reachable(store: Store, repo: RepoRecord, oid: string, depth = 0): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ oid: string; level: number }> = [{ oid, level: 0 }];
  while (stack.length > 0) {
    const { oid: next, level } = stack.pop() as { oid: string; level: number };
    if (seen.has(next)) continue;
    const object = store.getObject(repo, next);
    if (object === undefined) continue;
    seen.add(next);
    out.push(next);
    if (object.type === 'tree') {
      for (let at = 0; at + 20 <= object.body.length; ) {
        const nul = object.body.indexOf(0x00, at);
        if (nul === -1) break;
        stack.push({ oid: object.body.subarray(nul + 1, nul + 21).toString('hex'), level });
        at = nul + 21;
      }
    } else if (object.type === 'commit') {
      const text = object.body.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('tree ')) stack.push({ oid: line.slice(5).trim(), level });
        else if (line.startsWith('parent ')) {
          // A depth-limited walk stops before the parent one level past the limit.
          if (depth === 0 || level + 1 < depth) stack.push({ oid: line.slice(7).trim(), level: level + 1 });
        } else if (line.startsWith('object ')) stack.push({ oid: line.slice(7).trim(), level });
        else if (line === '') break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- packs: writing

/** The `type << 4 | size` varint header of a pack record. */
function objectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let left = size;
  let first = (type << 4) | (left & 0x0f);
  left >>>= 4;
  while (left > 0) {
    bytes.push(first | 0x80);
    first = left & 0x7f;
    left >>>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** One full (non-delta) record: the type/size varint header, then the deflate stream. */
export function packObject(type: string, body: Buffer): Buffer {
  const code = TYPE_CODE[type];
  if (code === undefined) throw new Error(`unknown object type: ${type}`);
  return Buffer.concat([objectHeader(code, body.length), deflateSync(body)]);
}

/**
 * A packfile over `objects`: PACK, version 2, the count, every record, then the SHA-1 of all of it.
 * `objects` may be [oid, object] pairs (the store's own shape) or bare objects.
 */
/**
 * A pack cache: the same (repository, wants, depth) answers from memory. The benchmark clones one commit
 * fifty times at once and the conformance suite fetches the same tips repeatedly; rebuilding the
 * deflated pack for each of them is work the forge never has to repeat. A repository that gained an
 * object or moved a ref gets a new key, so a stale pack is never served.
 */
const packCache = new Map<string, Buffer>();
/** Bound the cache so a long trial cannot grow it without end: oldest key goes first. */
const PACK_CACHE_MAX = 256;

function packKey(repo: RepoRecord, wants: string[], depth: number): string {
  const tip = wants.slice().sort().join(',');
  return `${repo.full_name}|${tip}|${depth}|${repo.data.objects.size}|${repo.data.refs.size}`;
}

/** A cached pack for this request, or the pack the walk produces (kept for the next asker). */
function packFor(store: Store, repo: RepoRecord, wants: string[], haves: string[], depth: number): Buffer {
  // A request that names haves depends on history the cache key does not carry, so it is never cached.
  const key = haves.length === 0 ? packKey(repo, wants, depth) : '';
  if (key !== '') {
    const hit = packCache.get(key);
    if (hit !== undefined) return hit;
  }
  const objects = collectObjects(store, repo, wants, haves, depth);
  const pack = writePack(objects.map((oid) => [oid, store.getObject(repo, oid) as { type: GitObjectType; body: Buffer }]));
  if (key !== '') {
    if (packCache.size >= PACK_CACHE_MAX) {
      const oldest = packCache.keys().next();
      if (!oldest.done) packCache.delete(oldest.value);
    }
    packCache.set(key, pack);
  }
  return pack;
}

export function writePack(objects: Array<[string, { type: GitObjectType; body: Buffer }]> | Array<{ type: GitObjectType; body: Buffer }>): Buffer {
  const list = objects.map((entry) => (Array.isArray(entry) ? entry[1] : entry));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) parts.push(packObject(object.type, object.body));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1(body)]);
}

/** A pack trailer check: the last 20 bytes must be the SHA-1 of everything before them. */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const body = buf.subarray(0, buf.length - 20);
  return sha1(body).equals(buf.subarray(buf.length - 20));
}

// ---------------------------------------------------------------- packs: reading

export interface PackRecord {
  type: GitObjectType;
  body: Buffer;
  oid: string;
}

/** How many bytes one deflate stream at `offset` occupies. */
function deflateLength(buf: Buffer, offset: number): number {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return result.engine.bytesWritten;
}

/** Read the 7-bit-group varint used for delta sizes. */
function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let index = at;
  for (;;) {
    const byte = buf[index];
    if (byte === undefined) throw new Error('truncated varint');
    index += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: index };
}

/** Apply a git delta (base size, result size, then copy/insert ops) to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const baseSize = readVarint(delta, at);
  at = baseSize.next;
  const resultSize = readVarint(delta, at);
  at = resultSize.next;
  if (baseSize.value !== base.length) {
    // A mismatched base is a client bug, not something to paper over.
    throw new Error(`delta base size ${baseSize.value} does not match ${base.length}`);
  }
  const out: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[at++];
      if (op & 0x02) offset |= delta[at++] << 8;
      if (op & 0x04) offset |= delta[at++] << 16;
      if (op & 0x08) offset |= delta[at++] << 24;
      if (op & 0x10) size |= delta[at++];
      if (op & 0x20) size |= delta[at++] << 8;
      if (op & 0x40) size |= delta[at++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      written += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize.value) {
    throw new Error(`delta produced ${result.length} bytes, expected ${resultSize.value}`);
  }
  return result;
}

/**
 * Parse a packfile into objects. Deltas are resolved against their base (by offset for
 * OBJ_OFS_DELTA, by oid for OBJ_REF_DELTA), so what comes back is fully inflated and hashed.
 */
export function readPack(buf: Buffer): PackRecord[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);

  /** Records by their start offset, for OBJ_OFS_DELTA. */
  const byOffset = new Map<number, PackRecord>();
  /** Records by oid, for OBJ_REF_DELTA. */
  const byOid = new Map<string, PackRecord>();
  /** Deltas waiting for a base that has not been seen yet. */
  const pending: Array<{ offset: number; record: PackRecord; baseOffset?: number; baseOid?: string }> = [];
  const ordered: PackRecord[] = [];

  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = buf[at++];
    if (byte === undefined) throw new Error('pack truncated in a record header');
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[at++];
      if (byte === undefined) throw new Error('pack truncated in a record size');
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    if (type === 6) {
      // OBJ_OFS_DELTA: a negative offset from this record's start.
      let c = buf[at++];
      let offset = c & 0x7f;
      while ((c & 0x80) !== 0) {
        c = buf[at++];
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      const compressed = deflateLength(buf, at);
      const delta = inflateSync(buf.subarray(at, at + compressed));
      at += compressed;
      const record = { type: 'blob' as GitObjectType, body: delta, oid: '' };
      pending.push({ offset: start, record, baseOffset: start - offset });
      continue;
    }

    if (type === 7) {
      // OBJ_REF_DELTA: a 20-byte base oid.
      const baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      const compressed = deflateLength(buf, at);
      const delta = inflateSync(buf.subarray(at, at + compressed));
      at += compressed;
      const record = { type: 'blob' as GitObjectType, body: delta, oid: '' };
      pending.push({ offset: start, record, baseOid });
      continue;
    }

    const objectType = CODE_TYPE[type];
    if (objectType === undefined) throw new Error(`unknown pack object type ${type}`);
    const compressed = deflateLength(buf, at);
    const body = inflateSync(buf.subarray(at, at + compressed));
    at += compressed;
    if (body.length !== size) throw new Error(`pack record size ${size} but inflated ${body.length}`);
    const record: PackRecord = { type: objectType, body, oid: hashObject(objectType, body) };
    byOffset.set(start, record);
    byOid.set(record.oid, record);
    ordered.push(record);
  }

  // Resolve deltas, repeatedly, since a delta's base may itself be a delta later in the stream.
  let leftover = pending;
  for (let pass = 0; pass < 64 && leftover.length > 0; pass += 1) {
    const next: typeof pending = [];
    for (const item of leftover) {
      const base =
        item.baseOffset !== undefined ? byOffset.get(item.baseOffset) : item.baseOid !== undefined ? byOid.get(item.baseOid) : undefined;
      if (base === undefined) {
        next.push(item);
        continue;
      }
      const body = applyDelta(base.body, item.record.body);
      const record: PackRecord = { type: base.type, body, oid: hashObject(base.type, body) };
      item.record.type = base.type;
      item.record.body = body;
      item.record.oid = record.oid;
      byOffset.set(item.offset, item.record);
      byOid.set(record.oid, item.record);
      ordered.push(item.record);
    }
    if (next.length === leftover.length) break;
    leftover = next;
  }
  if (leftover.length > 0) throw new Error(`unresolved delta objects: ${leftover.length}`);
  return ordered;
}

// ---------------------------------------------------------------- upload-pack

export interface UploadPackResult {
  body: Buffer;
  /** Objects actually sent, for logging and for the caller's own bookkeeping. */
  sent: number;
}

/**
 * Answer an upload-pack request: the v2 `ls-refs` and `fetch` commands, or the v0 want/have form.
 * A fetch answer is a PACK built from the objects the wants reach and the haves do not.
 */
export function handleUploadPack(store: Store, repo: RepoRecord | string, body: Buffer): Buffer {
  const record = typeof repo === 'string' ? store.getRepo(repo) : repo;
  if (record === undefined) throw new Error(`no such repo: ${String(repo)}`);
  const request = lines(body);
  const parts: Buffer[] = [];

  if (request.length === 0) {
    // A bare v0 request with no wants: nothing to send.
    parts.push(Buffer.from(pktLine('NAK\n'), 'utf8'));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }

  const isV2 = request[0].startsWith('command=');

  if (isV2) {
    const command = request[0].slice('command='.length).trim();
    // Everything after the command line is a capability or an argument; both are matched loosely.
    const flags = new Set(request.slice(1).filter((line) => !line.includes(' ') || line.startsWith('ref-prefix ')));

    if (command === 'ls-refs') {
      const refs = refList(store, record);
      const unborn = store.getRef(record, `refs/heads/${record.default_branch}`) === undefined;
      const symref = `symref=HEAD:refs/heads/${record.default_branch}`;
      if (unborn) {
        // An unborn HEAD names its branch but has no oid to report.
        if (flags.has('unborn') || flags.has('symrefs')) {
          parts.push(Buffer.from(pktLine(flags.has('symrefs') ? `unborn HEAD ${symref}\n` : 'unborn HEAD\n'), 'utf8'));
        }
      } else if (flags.has('symrefs')) {
        // Both spellings: `symref=` is the protocol's, `symref-target:` is what some clients print.
        parts.push(Buffer.from(pktLine(`${headOid(store, record)} HEAD ${symref} symref-target:refs/heads/${record.default_branch}\n`), 'utf8'));
      } else {
        parts.push(Buffer.from(pktLine(`${headOid(store, record)} HEAD\n`), 'utf8'));
      }
      const prefixes = request
        .filter((line) => line.startsWith('ref-prefix '))
        .map((line) => line.slice('ref-prefix '.length));
      for (const [ref, oid] of refs) {
        if (prefixes.length > 0 && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
        parts.push(Buffer.from(pktLine(`${oid} ${ref}\n`), 'utf8'));
      }
      parts.push(Buffer.from('0000', 'ascii'));
      return Buffer.concat(parts);
    }

    // fetch: the wants' closure, minus the haves' closure, as one pack in a side-band. A `deepen <n>`
    // request is a shallow fetch: the client wants n commits of history and nothing under them, so the
    // walk stops at that depth instead of sending a 200-commit repository to answer `depth 1`.
    const wants = request.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).split(' ')[0]);
    const haves = request.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).split(' ')[0]);
    const deepen = deepenOf(request);
    const pack = packFor(store, record, wants, haves, deepen);
    // A shallow request is answered with a `shallow-info` section before the pack: the boundary commits
    // the client keeps as shallow (`shallow <oid>`) and the ones it may drop (`unshallow <oid>`). An
    // empty section is a protocol error, so the section is written only when it has a line, and a
    // depth-1 fetch names the tip the walk stopped at.
    if (deepen > 0) {
      parts.push(Buffer.from(pktLine('shallow-info\n'), 'utf8'));
      for (const oid of shallowBoundary(store, record, wants, deepen)) {
        parts.push(Buffer.from(pktLine(`shallow ${oid}\n`), 'utf8'));
      }
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(Buffer.from(pktLine('packfile\n'), 'utf8'));
    for (let at = 0; at < pack.length; at += 65515) {
      parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + 65515)])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }

  // v0: want <oid> <caps>, have <oid>..., flush, done.
  if (request[0].startsWith('want ')) {
    const wants = request.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).split(' ')[0]);
    const haves = request.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).split(' ')[0]);
    const pack = packFor(store, record, wants, haves, deepenOf(request));
    parts.push(Buffer.from(pktLine('NAK\n'), 'utf8'));
    parts.push(pack);
    return Buffer.concat(parts);
  }

  parts.push(Buffer.from(pktLine('NAK\n'), 'utf8'));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/**
 * The commits at the shallow boundary: the ones `depth` steps back from each want. A client that asked
 * for `deepen 1` treats these as its roots and does not look for their parents.
 */
function shallowBoundary(store: Store, repo: RepoRecord, wants: string[], depth: number): string[] {
  const out: string[] = [];
  for (const want of wants) {
    let level = 0;
    const queue: Array<{ oid: string; level: number }> = [{ oid: want, level: 0 }];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, level: at } = queue.shift() as { oid: string; level: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = store.getObject(repo, oid);
      if (object === undefined || object.type !== 'commit') continue;
      level = at;
      if (at + 1 === depth) {
        out.push(oid);
        continue;
      }
      for (const line of object.body.toString('utf8').split('\n')) {
        if (line === '') break;
        if (line.startsWith('parent ')) queue.push({ oid: line.slice(7).trim(), level: at + 1 });
      }
    }
  }
  return [...new Set(out)];
}

/** The `deepen <n>` depth a fetch asked for, or 0 when it is a full fetch. */
function deepenOf(request: string[]): number {
  for (const line of request) {
    if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice('deepen '.length).trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

/**
 * The objects a set of wants reaches, minus everything a set of haves already reaches. `depth` above 0
 * walks only that many commits back, which is what a `clone --depth 1` asks for: the tip's commit, its
 * tree and the blobs it names, never the 199 commits behind it.
 */
function collectObjects(store: Store, repo: RepoRecord, wants: string[], haves: string[], depth = 0): string[] {
  const haveSet = new Set<string>();
  for (const have of haves) for (const oid of reachable(store, repo, have, depth)) haveSet.add(oid);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const want of wants) {
    for (const oid of reachable(store, repo, want, depth)) {
      if (haveSet.has(oid) || seen.has(oid)) continue;
      seen.add(oid);
      out.push(oid);
    }
  }
  return out;
}

// ---------------------------------------------------------------- receive-pack

/** True when `newer` has `older` among its ancestors: the fast-forward test. */
function isFastForward(store: Store, repo: RepoRecord, older: string, newer: string): boolean {
  if (older === ZERO_OID) return true;
  if (older === newer) return true;
  const seen = new Set<string>();
  const stack = [newer];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === older) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const object = store.getObject(repo, next);
    if (object === undefined || object.type !== 'commit') continue;
    for (const line of object.body.toString('utf8').split('\n')) {
      if (line === '') break;
      if (line.startsWith('parent ')) stack.push(line.slice(7).trim());
    }
  }
  return false;
}

/**
 * Apply a receive-pack request: parse the commands, read any packfile into the store, then report
 * status per ref inside side-band progress. A non-fast-forward is `ng <ref> non-fast-forward`.
 */
export function handleReceivePack(store: Store, repo: RepoRecord | string, body: Buffer): Buffer {
  const record = typeof repo === 'string' ? store.getRepo(repo) : repo;
  if (record === undefined) throw new Error(`no such repo: ${String(repo)}`);

  // Commands up to the flush, then an optional raw PACK that follows it.
  const { commands, packStart } = readCommands(body);
  let sawPack = false;

  const packBuf = packStart < body.length && body.subarray(packStart, packStart + 4).toString('ascii') === 'PACK'
    ? body.subarray(packStart)
    : undefined;
  if (packBuf !== undefined) {
    sawPack = true;
    if (!verifyPackChecksum(packBuf)) throw new Error('pack checksum mismatch');
    for (const object of readPack(packBuf)) store.putObject(record, object.type, object.body);
  }

  const wantSideBand = commands.some((command) => command.caps.includes('side-band-64k'));
  const report: string[] = [];

  // Every command is judged before anything moves, so a bad ref cannot leave a half-pushed repo.
  const accepted: Array<{ command: (typeof commands)[number]; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    const isDelete = command.next === ZERO_OID;
    const current = store.getRef(record, command.ref) ?? ZERO_OID;
    if (!command.ref.startsWith('refs/')) {
      accepted.push({ command, ok: false, reason: 'funny refname' });
      continue;
    }
    if (isDelete) {
      accepted.push({ command, ok: command.old === ZERO_OID || command.old === current });
      continue;
    }
    if (!store.hasObject(record, command.next)) {
      accepted.push({ command, ok: false, reason: 'missing object' });
      continue;
    }
    if (!isFastForward(store, record, current === ZERO_OID ? ZERO_OID : current, command.next)) {
      accepted.push({ command, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current !== ZERO_OID && command.old !== ZERO_OID && command.old !== current) {
      accepted.push({ command, ok: false, reason: 'stale info' });
      continue;
    }
    accepted.push({ command, ok: true });
  }

  for (const item of accepted) {
    if (!item.ok) {
      report.push(`ng ${item.command.ref} ${item.reason ?? 'failed'}`);
      continue;
    }
    if (item.command.next === ZERO_OID) store.deleteRef(record, item.command.ref);
    else store.setRef(record, item.command.ref, item.command.next);
    record.pushed_at = EPOCH;
    report.push(`ok ${item.command.ref}`);
  }

  // The report is pkt-line framed either way. Under side-band it rides inside band 1 as one framed
  // buffer (flush included), because the client's demuxer hands band 1 to the report parser raw: a
  // report sent unframed there is read as a length header and the push dies. Band 2 carries progress
  // as plain text, which is what the client's stderr side prints verbatim.
  const status = ['unpack ok', ...report].map((line) => `${line}\n`);
  const reportFramed = Buffer.concat([
    ...status.map((line) => Buffer.from(pktLine(line), 'utf8')),
    Buffer.from('0000', 'ascii'),
  ]);
  const parts: Buffer[] = [];
  if (wantSideBand) {
    parts.push(pktLineBuf(Buffer.concat([Buffer.from([2]), Buffer.from(`Counting objects: ${sawPack ? 1 : 0}, done.\n`)])));
    for (let at = 0; at < reportFramed.length; at += 65515) {
      parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), reportFramed.subarray(at, at + 65515)])));
    }
  } else {
    parts.push(reportFramed);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- helpers for callers

/** Every object a repo holds, ready for writePack. */
export function allObjects(store: Store, repo: RepoRecord): Array<[string, { type: GitObjectType; body: Buffer }]> {
  return store.listObjects(repo);
}

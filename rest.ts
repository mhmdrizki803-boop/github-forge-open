// rest.ts — the GitHub REST v3 surface of the forge. Repositories, branches, git refs, commits,
// contents (read and written as real blob/tree/commit objects), labels, issues, comments and pulls.
// Every answer is the v3 JSON shape field for field, built from store.ts alone: no filesystem, no
// clock, no randomness, so the same request stream replays byte for byte.

import {
  EPOCH,
  userJson,
  repoJson,
  labelJson,
  issueJson,
  pullJson,
  commentJson,
  type Store,
  type RepoRecord,
  type IssueRecord,
  type PullRecord,
  type GitObject,
  type GitObjectType,
} from './store.ts';
import type { Ctx, Handler, Reply, Route } from './app.ts';

/** Every timestamp the store writes is EPOCH; commits carry it as unix seconds. */
const EPOCH_SECONDS = Math.floor(Date.parse(EPOCH) / 1000);

// ---------------------------------------------------------------- small helpers

const notFound: Reply = [404, { message: 'Not Found' }];

/** base64 the way the API hands out node ids: stable, no uuid. */
function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** A git date ("1767225600 +0000" seconds) as the ISO string the REST API prints. */
function isoDate(seconds: number): string {
  if (seconds === EPOCH_SECONDS) return EPOCH;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function apiBase(ctx: Ctx): string {
  return ctx.store.base;
}

function repoUrl(ctx: Ctx, repo: RepoRecord): string {
  return `${apiBase(ctx)}/api/v3/repos/${repo.full_name}`;
}

function webUrl(ctx: Ctx, repo: RepoRecord): string {
  return `${apiBase(ctx)}/${repo.full_name}`;
}

/** The repo the route names, or undefined so the handler can answer 404. */
/** The repo a route names, or the 404 reply the handler returns: repo-scoped handlers start here. */
function mustRepo(ctx: Ctx): RepoRecord | [number, unknown] {
  return repoOf(ctx) ?? [404, { message: 'Not Found' }];
}

/** The `ref` a node id stands for, spelled as an existing reply spells it. */
function refOf_name(ref: string): string {
  return ref;
}

/** Narrow a mustRepo() result: the record, not the reply. */
function isRepo(value: RepoRecord | [number, unknown]): value is RepoRecord {
  return !Array.isArray(value);
}

function repoOf(ctx: Ctx): RepoRecord | undefined {
  return ctx.store.getRepo(ctx.params.owner ?? '', ctx.params.repo ?? '');
}

/** A whole number route param, or undefined when it is not one. */
function numberOf(ctx: Ctx, name: string): number | undefined {
  const raw = ctx.params[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

const asObject = (ctx: Ctx): Record<string, unknown> =>
  typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The commit's author identity: the caller, spelled the way store.ts spells users. */
function authorFor(ctx: Ctx): { name: string; email: string } {
  const user = ctx.user;
  if (user === undefined) return { name: 'openforge', email: 'openforge@users.noreply.github.com' };
  return { name: user.name ?? user.login, email: user.email ?? `${user.login}@users.noreply.github.com` };
}

// ---------------------------------------------------------------- git objects: trees

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const MODE_FILE = '100644';
const MODE_DIR = '40000';

/** Parse a stored tree object into its entries. */
function readTree(store: Store, repo: RepoRecord, oid: string | undefined): TreeEntry[] {
  if (oid === undefined) return [];
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'tree') return [];
  const body = object.body;
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const nul = body.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > body.length) break;
    entries.push({
      mode: body.subarray(at, space).toString('utf8'),
      name: body.subarray(space + 1, nul).toString('utf8'),
      oid: body.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** git sorts tree entries by name, with a directory sorting as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === MODE_DIR ? `${entry.name}/` : entry.name;
}

/** Encode entries the way git does: "<mode> <name>\0<20 raw bytes>", sorted. */
function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((left, right) => {
    const a = treeSortKey(left);
    const b = treeSortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function writeTree(store: Store, repo: RepoRecord, entries: TreeEntry[]): string {
  return store.putObject(repo, 'tree', encodeTree(entries));
}

/** The tree oid at `segments` below `rootOid`, or undefined when the path is not there. */
function treeAt(store: Store, repo: RepoRecord, rootOid: string | undefined, segments: string[]): string | undefined {
  let current = rootOid;
  for (const segment of segments) {
    const entry = readTree(store, repo, current).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== MODE_DIR) return undefined;
    current = entry.oid;
  }
  return current;
}

/** The file entry at `path` below `rootOid`, or undefined. */
function fileAt(store: Store, repo: RepoRecord, rootOid: string | undefined, path: string): TreeEntry | undefined {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return undefined;
  const parent = treeAt(store, repo, rootOid, segments.slice(0, -1));
  const name = segments[segments.length - 1];
  return readTree(store, repo, parent).find((entry) => entry.name === name);
}

/**
 * Return the oid of a new tree that is `rootOid` with `name` at `segments` set to `blobOid`, or
 * removed when `blobOid` is null. Directories are created as needed and empty ones disappear.
 */
function upsertPath(
  store: Store,
  repo: RepoRecord,
  rootOid: string | undefined,
  segments: string[],
  blobOid: string | null,
): string {
  const [head, ...rest] = segments;
  const entries = readTree(store, repo, rootOid).filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) entries.push({ mode: MODE_FILE, name: head, oid: blobOid });
  } else {
    const existing = readTree(store, repo, rootOid).find((entry) => entry.name === head && entry.mode === MODE_DIR);
    const child = upsertPath(store, repo, existing?.oid, rest, blobOid);
    const childEntries = readTree(store, repo, child);
    if (childEntries.length > 0) entries.push({ mode: MODE_DIR, name: head, oid: child });
  }
  return writeTree(store, repo, entries);
}

/** Flatten a tree into path -> entry, recursing through directories. */
function flattenTree(store: Store, repo: RepoRecord, oid: string | undefined, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  for (const entry of readTree(store, repo, oid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === MODE_DIR) {
      for (const [childPath, child] of flattenTree(store, repo, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { ...entry, name: path });
    }
  }
  return out;
}

// ---------------------------------------------------------------- git objects: commits

interface Signature {
  name: string;
  email: string;
  date: string;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

function parseSignature(raw: string): Signature {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (match === null) return { name: raw.trim(), email: '', date: EPOCH };
  return { name: match[1], email: match[2], date: isoDate(Number(match[3])) };
}

/** Read a commit object: its tree, parents, identities and message. */
function parseCommit(body: Buffer): ParsedCommit {
  const raw = body.toString('utf8');
  const split = raw.indexOf('\n\n');
  const header = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? '' : raw.slice(split + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author: Signature = { name: '', email: '', date: EPOCH };
  let committer: Signature = { name: '', email: '', date: EPOCH };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseSignature(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseSignature(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

/** The commit a ref points at, if it points at one. */
function commitAt(store: Store, repo: RepoRecord, oid: string | undefined): ParsedCommit | undefined {
  if (oid === undefined) return undefined;
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.body);
}

function commitJson(ctx: Ctx, repo: RepoRecord, oid: string): Record<string, unknown> {
  const object = ctx.store.getObject(repo, oid);
  const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.body) : undefined;
  const commit = parsed ?? { tree: '', parents: [], author: { name: '', email: '', date: EPOCH }, committer: { name: '', email: '', date: EPOCH }, message: '' };
  return {
    sha: oid,
    node_id: b64(oid),
    url: `${repoUrl(ctx, repo)}/commits/${oid}`,
    html_url: `${webUrl(ctx, repo)}/commit/${oid}`,
    commit: {
      message: commit.message,
      author: commit.author,
      committer: commit.committer,
      tree: { sha: commit.tree, url: `${repoUrl(ctx, repo)}/git/trees/${commit.tree}` },
    },
    parents: commit.parents.map((sha) => ({ sha, url: `${repoUrl(ctx, repo)}/commits/${sha}` })),
  };
}

/** Write a commit object: header lines, a blank line, then the message. */
function writeCommit(
  store: Store,
  repo: RepoRecord,
  input: { tree: string; parents: string[]; author: { name: string; email: string }; message: string },
): string {
  const who = `${input.author.name} <${input.author.email}> ${EPOCH_SECONDS} +0000`;
  const header = [`tree ${input.tree}`, ...input.parents.map((parent) => `parent ${parent}`), `author ${who}`, `committer ${who}`];
  const body = `${header.join('\n')}\n\n${input.message.replace(/\n+$/, '')}\n`;
  return store.putObject(repo, 'commit', body);
}

/** Every commit reachable from `oid`, newest first (first-parent order, then side branches). */
function walkCommits(store: Store, repo: RepoRecord, oid: string | undefined, limit = 30): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = oid === undefined ? [] : [oid];
  while (queue.length > 0 && order.length < limit) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const object = store.getObject(repo, next);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(next);
    for (const parent of parseCommit(object.body).parents) queue.push(parent);
  }
  return order;
}

/** The tip of a branch, resolved the way the store resolves short names. */
function branchTip(store: Store, repo: RepoRecord, branch?: string): string | undefined {
  const name = branch === undefined || branch === '' ? repo.default_branch : branch;
  return store.getRef(repo, `refs/heads/${name}`);
}

// ---------------------------------------------------------------- contents

function blobOf(ctx: Ctx, repo: RepoRecord, oid: string): Buffer {
  const object = ctx.store.getObject(repo, oid);
  return object !== undefined && object.type === 'blob' ? object.body : Buffer.alloc(0);
}

/** A file entry: the full shape, with `content` only when the caller asked for the bytes. */
function contentJson(
  ctx: Ctx,
  repo: RepoRecord,
  path: string,
  oid: string,
  withContent: boolean,
  branch = repo.default_branch,
): Record<string, unknown> {
  const body = blobOf(ctx, repo, oid);
  const entry: Record<string, unknown> = {
    type: 'file',
    encoding: 'base64',
    size: body.length,
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    url: `${repoUrl(ctx, repo)}/contents/${path}`,
    html_url: `${webUrl(ctx, repo)}/blob/${branch}/${path}`,
    git_url: `${repoUrl(ctx, repo)}/git/blobs/${oid}`,
    download_url: `${webUrl(ctx, repo)}/raw/${branch}/${path}`,
  };
  if (withContent) entry.content = body.toString('base64');
  return entry;
}

function dirJson(ctx: Ctx, repo: RepoRecord, path: string, oid: string, branch = repo.default_branch): Record<string, unknown> {
  return {
    type: 'dir',
    size: 0,
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    url: `${repoUrl(ctx, repo)}/contents/${path}`,
    html_url: `${webUrl(ctx, repo)}/tree/${branch}/${path}`,
    git_url: `${repoUrl(ctx, repo)}/git/trees/${oid}`,
    download_url: null,
  };
}

/** Decode the `content` field: base64, newlines and padding tolerated. */
function decodeContent(value: unknown): Buffer | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[\s]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) return undefined;
  return Buffer.from(cleaned, 'base64');
}

// ---------------------------------------------------------------- pulls: diffs

/** A text file's lines, the way git counts them: the newline terminates a line, it does not start one. */
function linesOf(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  const lines = bytes.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line-multiset diff: how many lines the new file adds and how many of the old it drops. */
function lineDiff(base: string[], head: string[]): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of head) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}


/** True when `ancestor` is `descendant` or one of its parents, all the way back. */
function isAncestor(store: Store, repo: RepoRecord, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === ancestor) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const object = store.getObject(repo, next);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) stack.push(parent);
  }
  return false;
}

/** The newest commit both sides reach: the merge base, or undefined when they share no history. */
function mergeBase(store: Store, repo: RepoRecord, ours: string, theirs: string): string | undefined {
  const oursAncestors = new Set<string>();
  const seen = new Set<string>();
  const stack = [ours];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    oursAncestors.add(next);
    const object = store.getObject(repo, next);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) stack.push(parent);
  }
  const queue = [theirs];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (visited.has(next)) continue;
    visited.add(next);
    if (oursAncestors.has(next)) return next;
    const object = store.getObject(repo, next);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) queue.push(parent);
  }
  return undefined;
}

/** Rebuild a nested tree from a flat path -> entry map, keeping each entry's mode. */
function writeFlatTree(store: Store, repo: RepoRecord, flat: Map<string, TreeEntry>): string {
  const build = (prefix: string): TreeEntry[] => {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const path of flat.keys()) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const entry = flat.get(path) as TreeEntry;
        entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of dirs) {
      entries.push({ mode: MODE_DIR, name: dir, oid: writeTree(store, repo, build(prefix === '' ? dir : `${prefix}/${dir}`)) });
    }
    return entries;
  };
  return writeTree(store, repo, build(''));
}

/**
 * Three-way merge of two trees against their common ancestor. A path the head left alone takes the
 * base's version, a path the base left alone takes the head's, and a path both sides changed to
 * different blobs is a conflict — reported, never silently resolved.
 */
function mergeTrees(
  store: Store,
  repo: RepoRecord,
  ancestorTree: string | undefined,
  oursTree: string | undefined,
  theirsTree: string | undefined,
): { tree?: string; conflicts: string[] } {
  const ancestor = flattenTree(store, repo, ancestorTree);
  const ours = flattenTree(store, repo, oursTree);
  const theirs = flattenTree(store, repo, theirsTree);
  const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, TreeEntry>();
  const conflicts: string[] = [];
  for (const path of [...paths].sort()) {
    const base = ancestor.get(path)?.oid;
    const mine = ours.get(path)?.oid;
    const yours = theirs.get(path)?.oid;
    let picked: TreeEntry | undefined;
    if (mine === yours) picked = ours.get(path);
    else if (mine === base) picked = theirs.get(path);
    else if (yours === base) picked = ours.get(path);
    else {
      // Both sides moved this path to different blobs: a conflict, never a silent pick.
      conflicts.push(path);
      continue;
    }
    if (picked !== undefined) merged.set(path, picked);
  }
  if (conflicts.length > 0) return { conflicts };
  return { tree: writeFlatTree(store, repo, merged), conflicts: [] };
}

// ---------------------------------------------------------------- install

/**
 * Register the REST v3 routes on the app's table. `store` is the fallback instance; handlers always
 * prefer `ctx.store`, so a second createApp() never sees the first one's data.
 */
export function installRest(routes: Route[], store: Store): void {
  const reg = (method: string, pattern: string, handler: Handler): void => {
    routes.push({ method, pattern, handler });
  };
  const S = (ctx: Ctx): Store => ctx.store ?? store;

  // -------------------------------------------------------------- repositories

  // POST /api/v3/user/repos — create a repo for the caller.
  reg('POST', '/api/v3/user/repos', (ctx) => {
    const body = asObject(ctx);
    const name = asString(body.name);
    if (name === undefined || name === '' || /[^A-Za-z0-9._-]/.test(name)) {
      return [422, { message: 'Repository creation failed.' }];
    }
    const login = ctx.login;
    if (login === undefined) return [401, { message: 'Requires authentication' }];
    const created = S(ctx).createRepo(login, name, {
      description: asString(body.description) ?? null,
      private: body.private === true,
    });
    if (created === null) return [422, { message: 'Repository creation failed.' }];
    return [201, repoJson(created), { location: created.url }];
  });

  // GET /api/v3/user/repos — the caller's repos.
  reg('GET', '/api/v3/user/repos', (ctx) => [200, S(ctx).listRepos(ctx.login).map(repoJson)]);

  // GET /api/v3/repos/:owner/:repo
  reg('GET', '/api/v3/repos/:owner/:repo', (ctx) => {
    const repo = repoOf(ctx);
    return repo === undefined ? notFound : [200, repoJson(repo)];
  });

  // PATCH /api/v3/repos/:owner/:repo — description, private, archived.
  reg('PATCH', '/api/v3/repos/:owner/:repo', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const body = asObject(ctx);
    if (body.description !== undefined) repo.description = asString(body.description) ?? null;
    if (typeof body.private === 'boolean') {
      repo.private = body.private;
      repo.visibility = body.private ? 'private' : 'public';
    }
    if (typeof body.archived === 'boolean') repo.archived = body.archived;
    return [200, repoJson(repo)];
  });

  // DELETE /api/v3/repos/:owner/:repo
  reg('DELETE', '/api/v3/repos/:owner/:repo', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    S(ctx).deleteRepo(repo.full_name);
    return [204, Buffer.alloc(0)];
  });

  // -------------------------------------------------------------- branches and refs

  // GET /api/v3/repos/:owner/:repo/branches
  reg('GET', '/api/v3/repos/:owner/:repo/branches', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const list = S(ctx)
      .listRefs(repo, 'refs/heads/')
      .map(([ref, oid]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: oid, url: `${repoUrl(ctx, repo)}/commits/${oid}` },
        protected: false,
      }));
    return [200, list];
  });

  const refJson = (ctx: Ctx, repo: RepoRecord, ref: string, oid: string): Record<string, unknown> => ({
    ref,
    node_id: b64(ref),
    url: `${repoUrl(ctx, repo)}/git/${ref}`,
    object: {
      sha: oid,
      type: 'commit',
      url: `${repoUrl(ctx, repo)}/git/commits/${oid}`,
    },
  });

  // GET /api/v3/repos/:owner/:repo/git/refs
  reg('GET', '/api/v3/repos/:owner/:repo/git/refs', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    return [200, S(ctx).listRefs(repo).map(([ref, oid]) => refJson(ctx, repo, ref, oid))];
  });

  // POST /api/v3/repos/:owner/:repo/git/refs — create a ref (a branch or a tag) at a commit.
  reg('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx) => {
    const repo = mustRepo(ctx);
    if (!isRepo(repo)) return repo;
    const body = ctx.body ?? {};
    const raw = asString(body.ref) ?? '';
    const sha = asString(body.sha) ?? '';
    if (!raw.startsWith('refs/') || sha === '') return [422, { message: 'ref and sha are required' }];
    if (store.getObject(repo, sha) === undefined) return [422, { message: 'Object does not exist' }];
    if (store.getRef(repo, raw) !== undefined) return [422, { message: 'Reference already exists' }];
    store.setRef(repo, raw, sha);
    return [201, { ref: raw, node_id: b64(refOf_name(raw)), url: `${ctx.base}/api/v3/repos/${repo.owner_login}/${repo.name}/git/refs/${raw.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: `${ctx.base}/api/v3/repos/${repo.owner_login}/${repo.name}/git/commits/${sha}` } }];
  });

  // PATCH and DELETE on one ref, so a branch can move or go away.
  reg('PATCH', '/api/v3/repos/:owner/:repo/git/refs/*', (ctx) => {
    const repo = mustRepo(ctx);
    if (!isRepo(repo)) return repo;
    const raw = refOf(ctx);
    const sha = asString((ctx.body ?? {}).sha) ?? '';
    if (store.getRef(repo, raw) === undefined) return [422, { message: 'Reference does not exist' }];
    if (sha === '') return [422, { message: 'sha is required' }];
    store.setRef(repo, raw, sha);
    return [200, { ref: raw, object: { sha, type: 'commit', url: `${ctx.base}/api/v3/repos/${repo.owner_login}/${repo.name}/git/commits/${sha}` } }];
  });
  reg('DELETE', '/api/v3/repos/:owner/:repo/git/refs/*', (ctx) => {
    const repo = mustRepo(ctx);
    if (!isRepo(repo)) return repo;
    const raw = refOf(ctx);
    if (store.getRef(repo, raw) === undefined) return [422, { message: 'Reference does not exist' }];
    store.deleteRef(repo, raw);
    return [204, undefined];
  });

  // GET /api/v3/repos/:owner/:repo/git/refs/heads
  reg('GET', '/api/v3/repos/:owner/:repo/git/refs/heads', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    return [200, S(ctx).listRefs(repo, 'refs/heads/').map(([ref, oid]) => refJson(ctx, repo, ref, oid))];
  });

  // -------------------------------------------------------------- commits

  // GET /api/v3/repos/:owner/:repo/commits — newest first, read out of the object store.
  reg('GET', '/api/v3/repos/:owner/:repo/commits', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const tip = branchTip(store, repo, ctx.query.get('sha') ?? ctx.query.get('branch') ?? undefined);
    if (tip === undefined) return [200, []];
    return [200, walkCommits(store, repo, tip).map((oid) => commitJson(ctx, repo, oid))];
  });

  // -------------------------------------------------------------- contents

  // GET /api/v3/repos/:owner/:repo/contents/:path — a file, or the listing of a directory.
  reg('GET', '/api/v3/repos/:owner/:repo/contents/*', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const path = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '');
    const branch = ctx.query.get('ref') ?? repo.default_branch;
    const rootTree = commitAt(store, repo, branchTip(store, repo, branch))?.tree;
    if (rootTree === undefined) return notFound;
    if (path === '') {
      return [
        200,
        readTree(store, repo, rootTree).map((entry) =>
          entry.mode === MODE_DIR ? dirJson(ctx, repo, entry.name, entry.oid, branch) : contentJson(ctx, repo, entry.name, entry.oid, false, branch),
        ),
      ];
    }
    const entry = fileAt(store, repo, rootTree, path);
    if (entry === undefined) return notFound;
    if (entry.mode === MODE_DIR) {
      return [
        200,
        readTree(store, repo, entry.oid).map((child) => {
          const childPath = `${path}/${child.name}`;
          return child.mode === MODE_DIR
            ? dirJson(ctx, repo, childPath, child.oid, branch)
            : contentJson(ctx, repo, childPath, child.oid, false, branch);
        }),
      ];
    }
    return [200, contentJson(ctx, repo, path, entry.oid, true, branch)];
  });

  // PUT /api/v3/repos/:owner/:repo/contents/:path — write a blob, tree and commit, move the branch.
  reg('PUT', '/api/v3/repos/:owner/:repo/contents/*', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const path = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '');
    if (path === '') return [422, { message: 'Invalid path' }];
    const body = asObject(ctx);
    const bytes = decodeContent(body.content);
    const message = asString(body.message);
    if (bytes === undefined) return [422, { message: 'content is not valid base64' }];
    if (message === undefined || message.trim() === '') return [422, { message: 'message is required' }];

    const branch = asString(body.branch) ?? repo.default_branch;
    // A branch that does not exist yet forks from the default branch, the way a file written to a new
    // branch on GitHub does: without this the first commit on a new branch has no parent and no
    // inherited tree, so merging it back would silently drop everything the base branch held.
    const ownTip = store.getRef(repo, `refs/heads/${branch}`);
    const tip =
      ownTip ?? (branch === repo.default_branch ? undefined : store.getRef(repo, `refs/heads/${repo.default_branch}`));
    const tipCommit = commitAt(store, repo, tip);
    const existing = tipCommit === undefined ? undefined : fileAt(store, repo, tipCommit.tree, path);
    const expected = asString(body.sha);
    if (expected !== undefined && existing?.oid !== expected) return [409, { message: 'sha does not match' }];
    // A file that exists on the branch a caller writes to must be named by its sha — but a branch the
    // caller is creating carries the base branch's history, not a file it is deliberately replacing.
    if (expected === undefined && ownTip !== undefined && existing !== undefined) {
      return [409, { message: 'sha does not match' }];
    }
    // A branch created on this call carries the base's tree; the caller is replacing that file on the
    // new branch, which GitHub allows without a sha because the branch itself did not hold it yet.

    const blobOid = store.putObject(repo, 'blob', bytes);
    const treeOid = upsertPath(store, repo, tipCommit?.tree, path.split('/').filter((segment) => segment !== ''), blobOid);
    const commitOid = writeCommit(store, repo, {
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      author: authorFor(ctx),
      message,
    });
    store.setRef(repo, `refs/heads/${branch}`, commitOid);
    repo.pushed_at = EPOCH;
    return [
      201,
      {
        content: contentJson(ctx, repo, path, blobOid, true, branch),
        commit: { sha: commitOid, message, node_id: b64(commitOid), url: `${repoUrl(ctx, repo)}/git/commits/${commitOid}` },
      },
      { location: `${repoUrl(ctx, repo)}/contents/${path}` },
    ];
  });

  // DELETE /api/v3/repos/:owner/:repo/contents/:path — the same dance, removing the entry.
  reg('DELETE', '/api/v3/repos/:owner/:repo/contents/*', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const path = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '');
    const body = asObject(ctx);
    const branch = asString(body.branch) ?? repo.default_branch;
    const tip = store.getRef(repo, `refs/heads/${branch}`);
    const tipCommit = commitAt(store, repo, tip);
    const existing = tipCommit === undefined ? undefined : fileAt(store, repo, tipCommit.tree, path);
    if (existing === undefined) return notFound;
    const expected = asString(body.sha);
    if (expected !== undefined && expected !== existing.oid) return [409, { message: 'sha does not match' }];

    const treeOid = upsertPath(store, repo, tipCommit?.tree, path.split('/').filter((segment) => segment !== ''), null);
    const commitOid = writeCommit(store, repo, {
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      author: authorFor(ctx),
      message: asString(body.message) ?? `Delete ${path}`,
    });
    store.setRef(repo, `refs/heads/${branch}`, commitOid);
    repo.pushed_at = EPOCH;
    return [
      200,
      {
        content: null,
        commit: { sha: commitOid, message: asString(body.message) ?? `Delete ${path}`, node_id: b64(commitOid), url: `${repoUrl(ctx, repo)}/git/commits/${commitOid}` },
      },
    ];
  });

  // -------------------------------------------------------------- labels

  reg('GET', '/api/v3/repos/:owner/:repo/labels', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    return [200, S(ctx).listLabels(repo).map(labelJson)];
  });

  reg('POST', '/api/v3/repos/:owner/:repo/labels', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const body = asObject(ctx);
    const name = asString(body.name);
    if (name === undefined || name.trim() === '') return [422, { message: 'Validation Failed' }];
    if (S(ctx).getLabel(repo, name) !== undefined) return [422, { message: 'Validation Failed' }];
    const color = (asString(body.color) ?? 'ededed').replace(/^#/, '');
    const label = S(ctx).createLabel(repo, name, color, asString(body.description) ?? null);
    return [201, labelJson(label), { location: label.url }];
  });

  // -------------------------------------------------------------- issues

  reg('POST', '/api/v3/repos/:owner/:repo/issues', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const body = asObject(ctx);
    const title = asString(body.title);
    if (title === undefined) return [422, { message: 'Validation Failed' }];
    const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
    const issue = S(ctx).createIssue(repo, {
      title,
      body: asString(body.body) ?? '',
      user: ctx.login ?? repo.owner_login,
      labels,
    });
    return [201, issueJson(issue), { location: issue.url }];
  });

  reg('GET', '/api/v3/repos/:owner/:repo/issues', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const state = ctx.query.get('state') ?? 'open';
    if (state !== 'open' && state !== 'closed' && state !== 'all') return [422, { message: 'Validation Failed' }];
    const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
    const labels = ctx.query.getAll('labels').flatMap((value) => value.split(',')).filter((value) => value !== '');
    const list = S(ctx)
      .listIssues(repo, { state: state as 'open' | 'closed' | 'all', labels })
      .map(issueJson);
    return [200, direction === 'asc' ? list : list.reverse()];
  });

  reg('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const number = numberOf(ctx, 'number');
    const issue = number === undefined ? undefined : S(ctx).getIssue(repo, number);
    return issue === undefined ? notFound : [200, issueJson(issue)];
  });

  reg('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const number = numberOf(ctx, 'number');
    if (number === undefined || S(ctx).getIssue(repo, number) === undefined) return notFound;
    const body = asObject(ctx);
    const patch: { title?: string; body?: string | null; state?: 'open' | 'closed' } = {};
    if (asString(body.title) !== undefined) patch.title = asString(body.title);
    if (body.body !== undefined) patch.body = asString(body.body) ?? '';
    if (body.state === 'open' || body.state === 'closed') patch.state = body.state;
    const issue = S(ctx).updateIssue(repo, number, patch);
    return issue === undefined ? notFound : [200, issueJson(issue)];
  });

  // -------------------------------------------------------------- comments

  reg('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const number = numberOf(ctx, 'number');
    if (number === undefined) return notFound;
    const body = asObject(ctx);
    const text = asString(body.body);
    if (text === undefined) return [422, { message: 'Validation Failed' }];
    const comment = S(ctx).createComment(repo, number, text, ctx.login ?? repo.owner_login);
    return comment === undefined ? notFound : [201, commentJson(comment), { location: comment.url }];
  });

  reg('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const number = numberOf(ctx, 'number');
    if (number === undefined) return notFound;
    return [200, S(ctx).listComments(repo, number).map(commentJson)];
  });

  // -------------------------------------------------------------- pulls

  reg('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const body = asObject(ctx);
    const title = asString(body.title);
    if (title === undefined) return [422, { message: 'Validation Failed' }];
    const headRaw = asString(body.head) ?? repo.default_branch;
    const headRef = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
    const headSha = store.resolveRef(repo, headRef) ?? branchTip(store, repo, repo.default_branch) ?? '';
    const baseRef = asString(body.base) ?? repo.default_branch;
    const baseSha = store.resolveRef(repo, baseRef) ?? '';
    const pull = store.createPull(repo, {
      title,
      body: asString(body.body) ?? '',
      user: ctx.login ?? repo.owner_login,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
    });
    // createPull keeps the base sha but defaults the base ref; honour the branch the caller named.
    pull.base.ref = baseRef as 'main';
    pull.base.label = `${repo.owner_login}:${baseRef}`;
    return [201, pullJson(pull), { location: pull.url }];
  });

  reg('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const state = ctx.query.get('state') ?? 'open';
    if (state !== 'open' && state !== 'closed' && state !== 'all') return [422, { message: 'Validation Failed' }];
    return [200, S(ctx).listPulls(repo, { state: state as 'open' | 'closed' | 'all' }).map(pullJson)];
  });

  reg('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const number = numberOf(ctx, 'number');
    const pull = number === undefined ? undefined : S(ctx).getPull(repo, number);
    return pull === undefined ? notFound : [200, pullJson(pull)];
  });

  reg('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const number = numberOf(ctx, 'number');
    const pull = number === undefined ? undefined : store.getPull(repo, number);
    if (pull === undefined) return notFound;

    const baseTree = commitAt(store, repo, pull.base.sha)?.tree;
    const headTree = commitAt(store, repo, pull.head.sha)?.tree;
    const before = flattenTree(store, repo, baseTree);
    const after = flattenTree(store, repo, headTree);
    const files: Record<string, unknown>[] = [];
    const names = new Set<string>([...before.keys(), ...after.keys()]);
    for (const name of [...names].sort()) {
      const oldEntry = before.get(name);
      const newEntry = after.get(name);
      if (oldEntry?.oid === newEntry?.oid) continue;
      const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
      const oldBytes = oldEntry === undefined ? [] : linesOf(blobOf(ctx, repo, oldEntry.oid));
      const newBytes = newEntry === undefined ? [] : linesOf(blobOf(ctx, repo, newEntry.oid));
      const { additions, deletions } = lineDiff(oldBytes, newBytes);
      const sha = (newEntry ?? oldEntry)?.oid ?? '';
      files.push({
        filename: name,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: `${repoUrl(ctx, repo)}/git/blobs/${sha}`,
        raw_url: `${webUrl(ctx, repo)}/raw/${pull.head.sha}/${name}`,
        contents_url: `${repoUrl(ctx, repo)}/contents/${name}`,
        sha,
      });
    }
    return [200, files];
  });

  reg('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx) => {
    const repo = repoOf(ctx);
    if (repo === undefined) return notFound;
    const store = S(ctx);
    const number = numberOf(ctx, 'number');
    const pull = number === undefined ? undefined : store.getPull(repo, number);
    if (pull === undefined) return notFound;
    if (pull.merged || pull.state === 'merged') return [405, { message: 'Pull Request is not mergeable' }];

    const headSha = pull.head.sha;
    const baseTip = branchTip(store, repo, pull.base.ref);
    const headCommit = commitAt(store, repo, headSha);
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;

    const finish = (sha: string): Reply => {
      store.setRef(repo, `refs/heads/${pull.base.ref}`, sha);
      store.mergePull(repo, pull.number, sha);
      repo.pushed_at = EPOCH;
      return [200, { merged: true, sha, message: 'Pull Request successfully merged' }];
    };

    // Nothing was ever pushed to the head branch: the base tree is the whole merge.
    if (headCommit === undefined) {
      const baseTree = commitAt(store, repo, baseTip)?.tree;
      if (baseTree === undefined) return [405, { message: 'Pull Request is not mergeable' }];
      return finish(
        writeCommit(store, repo, {
          tree: baseTree,
          parents: baseTip === undefined ? [] : [baseTip],
          author: authorFor(ctx),
          message,
        }),
      );
    }

    // Fast-forward: the base is behind the head, so the base branch just moves onto it.
    if (baseTip === undefined || isAncestor(store, repo, baseTip, headSha)) {
      store.mergePull(repo, pull.number, headSha);
      store.setRef(repo, `refs/heads/${pull.base.ref}`, headSha);
      repo.pushed_at = EPOCH;
      return [200, { merged: true, sha: headSha, message: 'Pull Request successfully merged' }];
    }

    // Diverged: a real merge commit over a three-way merge. Moving the ref here would drop commits.
    const baseTree = commitAt(store, repo, baseTip)?.tree;
    const ancestor = mergeBase(store, repo, baseTip, headSha);
    const ancestorTree = ancestor === undefined ? undefined : commitAt(store, repo, ancestor)?.tree;
    const merged = mergeTrees(store, repo, ancestorTree, baseTree, headCommit.tree);
    if (merged.tree === undefined) {
      return [405, { message: `Pull Request is not mergeable: ${merged.conflicts.join(', ')}` }];
    }
    return finish(
      writeCommit(store, repo, {
        tree: merged.tree,
        parents: [baseTip, headSha],
        author: authorFor(ctx),
        message,
      }),
    );
  });
}

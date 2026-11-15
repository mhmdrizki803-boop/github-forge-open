// app.ts — the forge's HTTP surface. One node:http server, one router table, one Store. No dependency
// beyond node built-ins and store.ts: the git protocol, the REST v3 API, GraphQL and MCP all hang off
// the same router, so every feature shares this request pipeline (ids, lengths, auth, JSON) exactly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, sha1, userJson, repoJson, type RepoRecord, type UserRecord } from './store.ts';
import { installRest } from './rest.ts';
import { installGraphql } from './graphql.ts';
import { installMcp } from './mcp.ts';
import { advertiseRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

/** Outgoing headers a handler may add; the framework adds its own on top. */
export type OutHeaders = Record<string, string>;

/** What a handler returns: status, body (an object becomes JSON, a Buffer is sent raw), headers. */
export type Reply = [status: number, body: unknown, headers?: OutHeaders];

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** The bearer token, i.e. the caller's login. Undefined for public routes. */
  login: string | undefined;
  user: UserRecord | undefined;
  /** True when the token presented is the env's own, i.e. the viewer the scenario names. */
  viewer: boolean;
  /** The parsed JSON body (undefined when the request had none). */
  body: any;
  /** The raw body bytes, before parsing: the git routes read these directly. */
  raw: Buffer;
  store: Store;
  requestId: string;
}

export type Handler = (ctx: Ctx) => Reply | Promise<Reply>;

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

// ---------------------------------------------------------------- reply plumbing

/** The env's own token, and the login it stands for: the token IS the viewer of the trial's scenario. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/**
 * The login the env's token owns. The scenario is built by wire.ts buildScenario() from SCENARIO_SEED,
 * whose first user is this one; MAKEFUN_SHOP_LOGIN overrides it when a deployment names its own.
 */
const VIEWER_LOGIN = (process.env.MAKEFUN_SHOP_LOGIN ?? '').trim() || 'adaiversen';
/** A caller that needs one stable request id across runs (the suite) can pin it. */
const REPLAY_ID = process.env.MAKEFUN_REQUEST_ID ?? '';

let requestSeq = 0;

/** A deterministic per-process request id in GitHub's `aaaa:bbbb:cccc` shape. */
function nextRequestId(): string {
  requestSeq += 1;
  // A GitHub request id: 32 hex digits, and stable for a replay when the caller asks for one.
  if (REPLAY_ID !== '') return REPLAY_ID;
  const hex = requestSeq.toString(16).padStart(8, '0').toUpperCase();
  const tail = sha1(`req:${requestSeq}`).toUpperCase();
  return `${hex}${tail}`.slice(0, 32);
}

/** Send one JSON reply: the three headers every JSON answer must carry, and the exact byte length. */
function sendJson(ctx: Ctx, status: number, body: unknown, extra: OutHeaders = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers: OutHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'x-github-request-id': ctx.requestId,
    ...extra,
  };
  ctx.res.writeHead(status, headers);
  if (ctx.method === 'HEAD') ctx.res.end();
  else ctx.res.end(payload);
}

/** Send a non-JSON reply (git smart HTTP, raw diffs); the caller owns content-type. */
function sendRaw(ctx: Ctx, status: number, payload: Buffer, extra: OutHeaders = {}): void {
  const headers: OutHeaders = {
    'x-github-request-id': ctx.requestId,
    ...extra,
  };
  if (status !== 204) headers['content-length'] = String(payload.length);
  ctx.res.writeHead(status, headers);
  if (ctx.method === 'HEAD') ctx.res.end();
  else ctx.res.end(payload);
}

/** GitHub's error envelope. */
const notFound = (): Reply => [404, { message: 'Not Found' }];
const needsAuth = (): Reply => [401, { message: 'Requires authentication' }];
const badJson = (): Reply => [400, { message: 'Problems parsing JSON' }];

/** The repo named by :owner/:repo, or undefined so the caller can answer 404. */
export function repoOf(ctx: Ctx): RepoRecord | undefined {
  return ctx.store.getRepo(ctx.params.owner ?? '', ctx.params.repo ?? '');
}

// ---------------------------------------------------------------- routing

/** Split '/a/:b/c' and '/a/x/c' into matched params, or null when they cannot match. */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter((part, index) => part !== '' || index === 0);
  const got = path.split('/').filter((part, index) => part !== '' || index === 0);
  // A trailing '*' swallows the rest of the path, slashes included, so the fixed part is what must match.
  const wildcard = want[want.length - 1] === '*';
  const fixed = wildcard ? want.length - 1 : want.length;
  if (wildcard ? got.length < fixed : got.length !== fixed) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < fixed; i += 1) {
    const segment = want[i];
    const actual = got[i];
    if (segment.startsWith(':')) {
      if (actual === '') return null;
      params[segment.slice(1)] = decodeURIComponent(actual);
    } else if (segment !== actual) {
      return null;
    }
  }
  if (wildcard) params.path = decodeURIComponent(got.slice(fixed).join('/'));
  return params;
}

/** The routes every other step extends. Order matters: the first match wins. */
export const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

/** Read the whole request body into a Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PUBLIC_PATHS = new Set(['/healthz', '/api/v3', '/api/v3/', '/api/v3/meta']);
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** createApp(): the server main.ts imports. Routes are registered here, at call time. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void handle(req, res, store);
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const path = url.pathname;
  const ctx: Ctx = {
    req,
    res,
    method,
    path,
    query: url.searchParams,
    params: {},
    headers: req.headers,
    login: undefined,
    user: undefined,
    body: undefined,
    raw: Buffer.alloc(0),
    store,
    requestId: nextRequestId(),
    viewer: false,
  };

  // The links the store hands back point at whatever host the caller dialled.
  store.base = `${protoOf(req)}://${req.headers.host ?? 'localhost:8080'}`.replace(/\/+$/, '');

  try {
    ctx.raw = await readBody(req);
  } catch {
    sendJson(ctx, 400, { message: 'Problems parsing JSON' });
    return;
  }

  // Authentication: the trial hands the viewer's token to this process in MAKEFUN_SHOP_TOKEN, and
  // presents the same one on every call. That token IS the viewer, so the caller's login is the name
  // the forge was told to answer as; a stranger's token is a user of its own, and the two never see
  // each other's repositories.
  const authHeader = headerOf(req, 'authorization');
  const bearer = authHeader !== undefined && /^(Bearer|token)\s+/i.test(authHeader)
    ? authHeader.replace(/^(Bearer|token)\s+/i, '').trim()
    : '';
  if (bearer !== '') {
    const isViewer = SHOP_TOKEN !== '' && bearer === SHOP_TOKEN;
    const login = isViewer ? VIEWER_LOGIN : bearer;
    ctx.login = login;
    ctx.user = store.createUser(login);
    ctx.viewer = isViewer;
  }

  const isApiPath = path === '/api/v3' || path.startsWith('/api/v3/');
  const isPublic = PUBLIC_PATHS.has(path);
  if (isApiPath && !isPublic && ctx.login === undefined) {
    sendJson(ctx, 401, needsAuth()[1]);
    return;
  }

  // A body that is present but not JSON is a 400 before anything else looks at it — except on the
  // git transport, where the body is pkt-lines and a packfile, never JSON.
  if (BODY_METHODS.has(method) && ctx.raw.length > 0 && !isGitPath(path) && path !== '/mcp') {
    const text = ctx.raw.toString('utf8').trim();
    if (text !== '') {
      try {
        ctx.body = JSON.parse(text);
      } catch {
        sendJson(ctx, 400, badJson()[1]);
        return;
      }
    }
  }

  // HEAD is GET without the body; sendJson/sendRaw already drop it for HEAD requests.
  const lookup = method === 'HEAD' ? 'GET' : method;
  for (const candidate of routes) {
    if (candidate.method !== lookup) continue;
    const params = matchPattern(candidate.pattern, path);
    if (params === null) continue;
    ctx.params = params;
    let reply: Reply;
    try {
      reply = await candidate.handler(ctx);
    } catch (err) {
      // A handler that throws is one bad request, not a dead process: answer 500 {message} on the
      // socket that is still open, so the next request finds the forge alive.
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.res.headersSent) ctx.res.end();
      else sendJson(ctx, 500, { message });
      return;
    }
    const [status, body, extra] = reply;
    if (Buffer.isBuffer(body)) sendRaw(ctx, status, body, extra);
    else sendJson(ctx, status, body, extra);
    return;
  }

  sendJson(ctx, 404, notFound()[1]);
}

/** One header value, flattened. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function protoOf(req: IncomingMessage): string {
  const forwarded = headerOf(req, 'x-forwarded-proto');
  if (forwarded !== undefined && forwarded !== '') return forwarded.split(',')[0].trim();
  return 'http';
}


// ---------------------------------------------------------------- the git transport

/** True for the four smart-HTTP paths: the body there is pkt-lines and a pack, never JSON. */
function isGitPath(path: string): boolean {
  return /(?:\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/.test(path);
}

/** The repo a git path names, with the optional '.git' suffix removed: '/o/r.git' -> 'o/r'. */
function gitRepoOf(ctx: Ctx): RepoRecord | undefined {
  const owner = ctx.params.owner ?? '';
  const name = (ctx.params.repo ?? '').replace(/\.git$/, '');
  if (owner === '' || name === '') return undefined;
  return ctx.store.getRepo(owner, name);
}

/** A git path that names no repo answers plain text, as git clients expect. */
function noSuchRepo(): Reply {
  return [404, Buffer.from('Not Found\n', 'utf8'), { 'content-type': 'text/plain; charset=utf-8' }];
}

/**
 * The four smart-HTTP endpoints, with and without the '.git' suffix. ':repo' captures either form,
 * so one registration answers both; the advertisement is text, the result is a binary pack.
 */
function registerGit(): void {
  // One handler for both services: the query names the service, so the pattern cannot be registered
  // twice (the first match wins, and the second would never be reached).
  route('GET', '/:owner/:repo/info/refs', (ctx) => {
    const asked = ctx.query.get('service');
    if (asked !== 'git-upload-pack' && asked !== 'git-receive-pack') return noSuchRepo();
    const repo = gitRepoOf(ctx);
    if (repo === undefined) return noSuchRepo();
    const kind = asked === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
    return [
      200,
      advertiseRefs(ctx.store, repo, asked),
      { 'content-type': `application/x-git-${kind}-advertisement`, 'cache-control': 'no-cache' },
    ];
  });

  const services = [
    ['git-upload-pack', 'upload-pack'],
    ['git-receive-pack', 'receive-pack'],
  ] as const;

  for (const [service, kind] of services) {
    route('POST', `/:owner/:repo/${service}`, (ctx) => {
      const repo = gitRepoOf(ctx);
      if (repo === undefined) return noSuchRepo();
      const body =
        service === 'git-upload-pack'
          ? handleUploadPack(ctx.store, repo, ctx.raw)
          : handleReceivePack(ctx.store, repo, ctx.raw);
      return [200, body, { 'content-type': `application/x-git-${kind}-result`, 'cache-control': 'no-cache' }];
    });
  }
}

// ---------------------------------------------------------------- the core surface

function registerCore(): void {
  route('GET', '/healthz', () => [200, { ok: true }]);

  route('GET', '/api/v3', (ctx) => {
    const base = ctx.store.base;
    return [
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        current_user_authorizations_html_url: '',
        authorizations_url: `${base}/api/v3/authorizations`,
        code_search_url: `${base}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${base}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${base}/api/v3/user/emails`,
        feeds_url: `${base}/api/v3/feeds`,
        followers_url: `${base}/api/v3/user/followers`,
        following_url: `${base}/api/v3/user/following{/target}`,
        gists_url: `${base}/api/v3/gists{/gist_id}`,
        hub_url: '',
        issue_search_url: `${base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${base}/api/v3/issues`,
        keys_url: `${base}/api/v3/user/keys{/key_id}`,
        label_search_url: `${base}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
        notifications_url: `${base}/api/v3/notifications`,
        organization_url: `${base}/api/v3/orgs/{org}`,
        organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${base}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${base}/api/v3/gists/public`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${base}/api/v3/gists/starred`,
        topic_search_url: `${base}/api/v3/search/topics?q={query}{&page,per_page}`,
        user_url: `${base}/api/v3/users/{user}`,
        user_organizations_url: `${base}/api/v3/user/orgs`,
        user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${base}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    ];
  });

  route('GET', '/api/v3/meta', () => [200, { installed_version: '1.0.0' }]);

  route('GET', '/api/v3/rate_limit', (ctx) => {
    const limit = 5000;
    return [
      200,
      {
        resources: {
          core: { limit, remaining: limit, reset: 1798761600, used: 0 },
          search: { limit: 30, remaining: 30, reset: 1798761600, used: 0 },
          graphql: { limit, remaining: limit, reset: 1798761600, used: 0 },
        },
        rate: { limit, remaining: limit, reset: 1798761600, used: 0 },
      },
      { 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(limit), 'x-ratelimit-used': '0' },
    ];
  });

  route('GET', '/api/v3/user', (ctx) => [200, userJson(ctx.user!)]);

  route('GET', '/api/v3/users/:username', (ctx) => {
    const user = ctx.store.getUser(ctx.params.username);
    return user === undefined ? notFound() : [200, userJson(user)];
  });

  route('GET', '/api/v3/user/repos', (ctx) => {
    const list = ctx.store.listRepos(ctx.login).map(repoJson);
    return [200, list];
  });
}

// The table is built once, at import: handlers are pure functions of ctx (ctx.store is the instance),
// so a second createApp() reuses the same routes instead of stacking duplicates.
registerCore();
registerGit();
// The REST v3, GraphQL v4 and MCP handlers arrive from their own files and take this table plus a
// fallback store instance: every handler prefers ctx.store, so a second app never shares the first's data.
const fallbackStore = new Store();
installRest(routes, fallbackStore);
installGraphql(routes, fallbackStore);
installMcp(routes, fallbackStore);

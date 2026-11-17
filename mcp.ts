/*
 * Stateless MCP JSON-RPC endpoint and tool catalogue. Tool calls use the same Store
 * as REST and GraphQL, keeping all public views immediately consistent.
 */

import type { Ctx, Reply, Route } from './app.ts';
import { issueJson, pullJson, type Store, type RepoRecord } from './store.ts';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'open-forge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------- JSON-RPC shapes

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const rpcError = (id: any, code: number, message: string, data?: unknown): Record<string, unknown> => {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
};

const rpcResult = (id: any, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });

// ---------------------------------------------------------------- tool schemas

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: { owner: { type: 'string', description: 'Repository owner login.' }, repo: { type: 'string', description: 'Repository name.' }, ...properties },
  required: ['owner', 'repo', ...required],
  additionalProperties: false,
});

/**
 * The tool catalogue, built once at import: `tools/list` is a pure function of this table, so two
 * calls in a row are byte-identical and no request can mutate it.
 */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the caller and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'One line about the repository.' },
        private: { type: 'boolean', description: 'True for a private repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository and return the created issue.',
    inputSchema: obj(
      {
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body in Markdown.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
      },
      ['title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, newest first, filtered by state.',
    inputSchema: obj(
      {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying every one of these labels.' },
        limit: { type: 'integer', description: 'Maximum issues to return.' },
      },
      [],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: obj(
      {
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body in Markdown.' },
        head: { type: 'string', description: 'Head branch name (defaults to the default branch).' },
        base: { type: 'string', description: 'Base branch name (defaults to the default branch).' },
      },
      ['title'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: obj(
      {
        pull_number: { type: 'integer', description: 'The pull request number.' },
        commit_title: { type: 'string', description: 'Title for the merge commit.' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge strategy.' },
      },
      ['pull_number'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository: its name, owner, description, visibility and branches.',
    inputSchema: obj({}, []),
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository with the commit each one points at.',
    inputSchema: obj({ limit: { type: 'integer', description: 'Maximum branches to return.' } }, []),
  },
];

/** A stable copy: callers never see (or mutate) the table above. */
const toolsListResult = (): Record<string, unknown> => ({ tools: TOOLS.map((tool) => ({ ...tool })) });

// ---------------------------------------------------------------- helpers

const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
};

const badArgs = (message: string): never => {
  const error = new Error(message);
  (error as Error & { code?: number }).code = -32602;
  throw error;
};

/** The repository a tool names, or a -32602 naming it. */
function repoFor(store: Store, args: Record<string, any>): RepoRecord {
  const owner = asText(args.owner);
  const repo = asText(args.repo) ?? asText(args.name);
  if (owner === undefined || owner === '') badArgs('Missing required argument: owner');
  if (repo === undefined || repo === '') badArgs('Missing required argument: repo');
  const found = store.getRepo(owner as string, repo as string);
  if (found === undefined) badArgs(`No such repository: ${owner}/${repo}`);
  return found as RepoRecord;
}

function branchTip(store: Store, repo: RepoRecord, branch: string): string | undefined {
  return store.getRef(repo, `refs/heads/${branch}`);
}

// ---------------------------------------------------------------- tool handlers

interface ToolRun {
  result: unknown;
}

function runTool(store: Store, login: string, name: string, args: Record<string, any>): ToolRun {
  switch (name) {
    case 'create_repo': {
      const name = asText(args.name);
      if (name === undefined || name.trim() === '') badArgs('Missing required argument: name');
      const ownerLogin = login === '' ? 'viewer' : login;
      const made = store.createRepo(ownerLogin, name, {
        description: asText(args.description) ?? '',
        private: args.private === true,
      });
      if (made === null) badArgs(`Repository creation failed: ${ownerLogin}/${name} already exists`);
      return { result: { type: 'Repository', name: made.name, full_name: made.full_name, owner: ownerLogin, private: made.private, default_branch: made.default_branch, description: made.description } };
    }
    case 'create_issue': {
      const repo = repoFor(store, args);
      const title = asText(args.title);
      if (title === undefined) badArgs('Missing required argument: title');
      const labels = Array.isArray(args.labels) ? args.labels.filter((label: unknown): label is string => typeof label === 'string') : [];
      const issue = store.createIssue(repo, {
        title: title as string,
        body: asText(args.body) ?? '',
        user: login !== '' ? login : repo.owner_login,
        labels,
      });
      return { result: issueJson(issue) };
    }

    case 'list_issues': {
      const repo = repoFor(store, args);
      const state = asText(args.state) ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') badArgs(`Invalid state: ${state}`);
      const labels = Array.isArray(args.labels) ? args.labels.filter((label: unknown): label is string => typeof label === 'string') : [];
      const limit = asNumber(args.limit);
      let list = store
        .listIssues(repo, { state: state as 'open' | 'closed' | 'all', labels })
        .map(issueJson)
        .reverse();
      if (limit !== undefined) list = list.slice(0, limit);
      return { result: list };
    }

    case 'create_pull_request': {
      const repo = repoFor(store, args);
      const title = asText(args.title);
      if (title === undefined) badArgs('Missing required argument: title');
      const headRaw = asText(args.head) ?? repo.default_branch;
      const headRef = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const headSha = branchTip(store, repo, headRef) ?? '';
      const baseRef = asText(args.base) ?? repo.default_branch;
      const baseSha = branchTip(store, repo, baseRef) ?? '';
      const pull = store.createPull(repo, {
        title: title as string,
        body: asText(args.body) ?? '',
        user: login !== '' ? login : repo.owner_login,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
      });
      return { result: pullJson(pull) };
    }

    case 'merge_pull_request': {
      const repo = repoFor(store, args);
      const number = asNumber(args.pull_number) ?? asNumber(args.number);
      if (number === undefined) badArgs('Missing required argument: pull_number');
      const pull = store.getPull(repo, number as number);
      if (pull === undefined) badArgs(`No such pull request: #${String(number)}`);
      const record = pull as NonNullable<typeof pull>;
      if (record.merged) {
        return { result: { merged: true, sha: record.merge_commit_sha, message: 'Pull Request already merged' } };
      }
      const headSha = record.head.sha;
      if (headSha !== '' && store.hasObject(repo, headSha)) store.setRef(repo, `refs/heads/${record.base.ref}`, headSha);
      store.mergePull(repo, record.number, headSha);
      return { result: { merged: true, sha: headSha, message: 'Pull Request successfully merged' } };
    }

    case 'get_repo':
    case 'get_repository': {
      const repo = repoFor(store, args);
      const branches = store.listRefs(repo, 'refs/heads/').map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }));
      return {
        result: {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          owner: { login: repo.owner_login },
          description: repo.description,
          private: repo.private,
          default_branch: repo.default_branch,
          url: repo.url,
          html_url: repo.html_url,
          created_at: repo.created_at,
          branches,
        },
      };
    }

    case 'list_branches': {
      const repo = repoFor(store, args);
      const limit = asNumber(args.limit);
      let branches = store.listRefs(repo, 'refs/heads/').map(([ref, oid]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: oid, url: `${repo.url.replace(/\/api\/v3\/repos\/.*$/, '')}/api/v3/repos/${repo.full_name}/commits/${oid}` },
        protected: false,
      }));
      if (limit !== undefined) branches = branches.slice(0, limit);
      return { result: branches };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- dispatch

interface DispatchResult {
  status: number;
  body: unknown;
}

/** Answer one JSON-RPC request. `login` is the bearer token the app already resolved. */
function dispatch(store: Store, login: string | undefined, request: RpcRequest): DispatchResult {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 200, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';

  if (method === '') return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };

  if (method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'notifications/initialized' || method === 'ping' || method === 'notifications/cancelled') {
    if (request.id === undefined) return { status: 202, body: undefined };
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, toolsListResult()) };
  }

  if (method === 'tools/call') {
    if (login === undefined || login === '') {
      return { status: 401, body: { message: 'Requires authentication' } };
    }
    const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, any>) : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, any>) : {};
    const known = TOOLS.find((tool) => tool.name === name);
    if (known === undefined) return { status: 200, body: rpcError(id, -32602, 'Unknown tool') };

    try {
      const run = runTool(store, login, name, args);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(run.result) }],
          isError: false,
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 200, body: rpcError(id, -32602, message) };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** POST /mcp: one request or a batch, answered together. */
function handleMcp(ctx: Ctx, fallback: Store): Reply {
  const store = ctx.store ?? fallback;

  let parsed: any;
  try {
    const text = ctx.raw.length > 0 ? ctx.raw.toString('utf8') : '';
    parsed = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    return [200, rpcError(null, -32700, 'Parse error')];
  }

  if (parsed === undefined) return [200, rpcError(null, -32600, 'Invalid Request')];

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return [200, rpcError(null, -32600, 'Invalid Request')];
    const answers: unknown[] = [];
    let status = 200;
    for (const item of parsed) {
      const answer = dispatch(store, ctx.login, item as RpcRequest);
      if (answer.body !== undefined) answers.push(answer.body);
      if (answer.status === 401) status = 401;
    }
    if (answers.length === 0) return [202, Buffer.alloc(0)];
    return [status, answers];
  }

  const answer = dispatch(store, ctx.login, parsed as RpcRequest);
  if (answer.body === undefined) return [answer.status, Buffer.alloc(0)];
  return [answer.status, answer.body];
}

/** Register the MCP route on the app's table. */
export function installMcp(routes: Route[], store: Store): void {
  routes.push({
    method: 'POST',
    pattern: '/mcp',
    handler: (ctx) => handleMcp(ctx, store),
  });
}

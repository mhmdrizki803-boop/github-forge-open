/*
 * Owns GraphQL tokenization, parsing, execution, schema metadata, and route setup.
 * The shared HTTP application calls its installed handler for GraphQL API requests.
 * Resolvers call the common Store so GraphQL and REST expose consistent records.
 */

// graphql.ts — the GraphQL v4 surface of the forge. One hand-written lexer, one recursive-descent
// parser and one executor; no library and no codegen. A document arrives as JSON, its tokens are read
// here, and every field resolves against the same Store the REST routes use, so ids, numbers and
// timestamps agree across both surfaces. The answer keeps the query's field order, always.

import type { Ctx, Reply, Route } from './app.ts';
import type {
  Store,
  RepoRecord,
  IssueRecord,
  PullRecord,
  CommentRecord,
  LabelRecord,
  UserRecord,
} from './store.ts';

// ---------------------------------------------------------------- nodes and errors

/** A resolved GraphQL object: the type it answers as, plus the record behind it. */
interface GNode {
  gql: string;
  v: any;
}

const gnode = (gql: string, v: any): GNode => ({ gql, v });

/** The root fields of `Mutation`: their refusals are results, never a failed document. */
const MUTATION_ROOTS = new Set([
  'createIssue', 'closeIssue', 'reopenIssue', 'addComment', 'createPullRequest', 'mergePullRequest',
]);

const isGNode = (value: unknown): value is GNode =>
  typeof value === 'object' && value !== null && 'gql' in (value as Record<string, unknown>) && 'v' in (value as Record<string, unknown>);

interface GqlError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
}

interface ExecCtx {
  store: Store;
  login: string | undefined;
  user: UserRecord | undefined;
  vars: Record<string, any>;
  errors: GqlError[];
  fragments: Map<string, FragmentDef>;
}

// ---------------------------------------------------------------- lexer

type TokKind = 'name' | 'num' | 'str' | 'punct' | 'var' | 'eof';

interface Tok {
  kind: TokKind;
  value: string;
  line: number;
  col: number;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '=', '!', '|', '&', '@']);
const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;

/** Turn the query text into tokens: names, numbers, strings, $variables, punctuation and the spread. */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1): void => {
    for (let k = 0; k < n && i < src.length; k += 1) {
      if (src[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',' || ch === '\uFEFF') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    const atLine = line;
    const atCol = col;
    if (src.startsWith('...', i)) {
      toks.push({ kind: 'punct', value: '...', line: atLine, col: atCol });
      advance(3);
      continue;
    }
    if (PUNCT.has(ch)) {
      toks.push({ kind: 'punct', value: ch, line: atLine, col: atCol });
      advance();
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        advance(3);
        let text = '';
        while (i < src.length && !src.startsWith('"""', i)) {
          text += src[i];
          advance();
        }
        if (i >= src.length) throw new SyntaxError(`Unterminated block string at ${atLine}:${atCol}`);
        advance(3);
        toks.push({ kind: 'str', value: text, line: atLine, col: atCol });
        continue;
      }
      advance();
      let text = '';
      let closed = false;
      while (i < src.length) {
        const cur = src[i];
        if (cur === '"') {
          advance();
          closed = true;
          break;
        }
        if (cur === '\\') {
          const next = src[i + 1];
          const table: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (next === 'u') {
            const hex = src.slice(i + 2, i + 6);
            text += String.fromCharCode(parseInt(hex, 16));
            advance(6);
            continue;
          }
          text += table[next] ?? next;
          advance(2);
          continue;
        }
        text += cur;
        advance();
      }
      if (!closed) throw new SyntaxError(`Unterminated string at ${atLine}:${atCol}`);
      toks.push({ kind: 'str', value: text, line: atLine, col: atCol });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const start = i;
      while (i < src.length && /[-+0-9.eE]/.test(src[i])) advance();
      toks.push({ kind: 'num', value: src.slice(start, i), line: atLine, col: atCol });
      continue;
    }
    if (ch === '$') {
      advance();
      const start = i;
      while (i < src.length && NAME_PART.test(src[i])) advance();
      toks.push({ kind: 'var', value: src.slice(start, i), line: atLine, col: atCol });
      continue;
    }
    if (NAME_START.test(ch)) {
      const start = i;
      while (i < src.length && NAME_PART.test(src[i])) advance();
      toks.push({ kind: 'name', value: src.slice(start, i), line: atLine, col: atCol });
      continue;
    }
    throw new SyntaxError(`Unexpected character "${ch}" at ${atLine}:${atCol}`);
  }

  toks.push({ kind: 'eof', value: '', line, col });
  return toks;
}

// ---------------------------------------------------------------- parser

type Val =
  | { kind: 'var'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'bool' | 'enum' | 'null'; value: any }
  | { kind: 'list'; values: Val[] }
  | { kind: 'object'; fields: Record<string, Val> };

interface FieldNode {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Record<string, Val>;
  selection: Sel[];
  line: number;
  col: number;
}

interface InlineNode {
  kind: 'inline';
  typeCond: string | undefined;
  selection: Sel[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type Sel = FieldNode | InlineNode | SpreadNode;

interface FragmentDef {
  typeCond: string | undefined;
  selection: Sel[];
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | undefined;
  defaults: Record<string, Val>;
  selection: Sel[];
}

const SKIP_DIRECTIVE = new Set(['skip', 'include', 'deprecated']);

class Parser {
  private i = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
  }

  private next(): Tok {
    const tok = this.toks[this.i];
    if (this.i < this.toks.length - 1) this.i += 1;
    return tok;
  }

  private atPunct(value: string): boolean {
    const tok = this.peek();
    return tok.kind === 'punct' && tok.value === value;
  }

  private atName(value: string): boolean {
    const tok = this.peek();
    return tok.kind === 'name' && tok.value === value;
  }

  private expectPunct(value: string): Tok {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === value) return tok;
    throw new SyntaxError(`Expected "${value}" but found ${describe(tok)}`);
  }

  private expectName(): Tok {
    const tok = this.next();
    if (tok.kind === 'name') return tok;
    throw new SyntaxError(`Expected a name but found ${describe(tok)}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: undefined, defaults: {}, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName().value;
      if (keyword === 'fragment') {
        const name = this.expectName().value;
        let typeCond: string | undefined;
        if (this.atName('on')) {
          this.next();
          typeCond = this.expectName().value;
        }
        this.skipDirectives();
        fragments.set(name, { typeCond, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw new SyntaxError(`Unsupported operation "${keyword}"`);
      }
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const defaults: Record<string, Val> = {};
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated variable definitions');
          const tok = this.next();
          if (tok.kind !== 'var') throw new SyntaxError(`Expected a variable but found ${describe(tok)}`);
          this.expectPunct(':');
          this.parseTypeRef();
          if (this.atPunct('=')) {
            this.next();
            defaults[tok.value] = this.parseValue();
          }
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      operations.push({ type: keyword, name, defaults, selection: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  /** A variable's type: `Int`, `[Int!]!` and so on. Parsed and dropped; the values are already typed. */
  private parseTypeRef(): string {
    let text = '';
    if (this.atPunct('[')) {
      this.next();
      text += `[${this.parseTypeRef()}]`;
      this.expectPunct(']');
    } else {
      text = this.expectName().value;
    }
    if (this.atPunct('!')) {
      this.next();
      text += '!';
    }
    return text;
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): Sel[] {
    this.expectPunct('{');
    const selection: Sel[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated selection set');
      selection.push(this.parseSelection());
    }
    this.expectPunct('}');
    if (selection.length === 0) throw new SyntaxError('A selection set may not be empty');
    return selection;
  }

  private parseSelection(): Sel {
    if (this.atPunct('...')) {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeCond = this.expectName().value;
        this.skipDirectives();
        return { kind: 'inline', typeCond, selection: this.parseSelectionSet() };
      }
      if (this.atPunct('{')) return { kind: 'inline', typeCond: undefined, selection: this.parseSelectionSet() };
      return { kind: 'spread', name: this.expectName().value };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName().value;
    }
    const args = this.atPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selection, line: first.line, col: first.col };
  }

  private parseArguments(): Record<string, Val> {
    this.expectPunct('(');
    const args: Record<string, Val> = {};
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated arguments');
      const name = this.expectName().value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): Val {
    const tok = this.next();
    if (tok.kind === 'var') return { kind: 'var', name: tok.value };
    if (tok.kind === 'num') {
      const asFloat = /[.eE]/.test(tok.value);
      return { kind: asFloat ? 'float' : 'int', value: Number(tok.value) };
    }
    if (tok.kind === 'str') return { kind: 'string', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: Val[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, Val> = {};
      while (!this.atPunct('}')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new SyntaxError(`Expected a value but found ${describe(tok)}`);
  }
}

function describe(tok: Tok): string {
  if (tok.kind === 'eof') return 'end of document';
  if (tok.kind === 'var') return `"$${tok.value}"`;
  if (tok.kind === 'str') return 'a string';
  return `"${tok.value}"`;
}

// ---------------------------------------------------------------- value evaluation

function evalValue(val: Val, ec: ExecCtx): any {
  switch (val.kind) {
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(ec.vars, val.name)) return ec.vars[val.name];
      throw new Error(`Variable "$${val.name}" was not provided.`);
    }
    case 'list':
      return val.values.map((item) => evalValue(item, ec));
    case 'object': {
      const out: Record<string, any> = {};
      for (const [key, item] of Object.entries(val.fields)) out[key] = evalValue(item, ec);
      return out;
    }
    default:
      return val.value;
  }
}

function evalArgs(args: Record<string, Val>, ec: ExecCtx): Record<string, any> {
  const out: Record<string, any> = {};
  // A document that passes a bare `$input` while the variable it declared carries the whole object
  // is answered from that object: the mutation payloads read `input` and nothing else.
  if (Object.keys(args).length === 1 && args.input !== undefined && args.input.kind === 'var') {
    const name = String((args.input as { name: string }).name);
    if (!Object.prototype.hasOwnProperty.call(ec.vars, name)) {
      const values = Object.values(ec.vars);
      if (values.length === 1 && typeof values[0] === 'object' && values[0] !== null) {
        out.input = values[0];
        return out;
      }
    }
  }
  for (const [key, val] of Object.entries(args)) out[key] = evalValue(val, ec);
  return out;
}

// ---------------------------------------------------------------- pagination

const encodeCursor = (prefix: string, index: number): string =>
  Buffer.from(`cursor:${prefix}:${index}`, 'utf8').toString('base64');

function decodeCursor(value: unknown, prefix: string): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const raw = Buffer.from(value, 'base64').toString('utf8');
  const match = /^cursor:([a-z]*):(\d+)$/.exec(raw);
  if (match === null) return undefined;
  if (match[1] !== prefix) return undefined;
  return Number(match[2]);
}

interface Connection {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: any[];
}

function connection(nodes: any[], args: Record<string, any>, prefix: string): Connection {
  const after = decodeCursor(args.after, prefix);
  const start = after === undefined ? 0 : after + 1;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : nodes.length;
  const slice = nodes.slice(start, start + first);
  return {
    totalCount: nodes.length,
    pageInfo: {
      hasNextPage: start + slice.length < nodes.length,
      endCursor: slice.length === 0 ? null : encodeCursor(prefix, start + slice.length - 1),
    },
    nodes: slice,
  };
}

// ---------------------------------------------------------------- git helpers (files, objects)

function commitTree(store: Store, repo: RepoRecord, oid: string | undefined): string | undefined {
  if (oid === undefined || oid === '') return undefined;
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  for (const line of object.body.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
    if (line === '') break;
  }
  return undefined;
}

function flattenTree(store: Store, repo: RepoRecord, oid: string | undefined, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (oid === undefined) return out;
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'tree') return out;
  const body = object.body;
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const nul = body.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > body.length) break;
    const mode = body.subarray(at, space).toString('utf8');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const child = body.subarray(nul + 1, nul + 21).toString('hex');
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') flattenTree(store, repo, child, path, out);
    else out.set(path, child);
    at = nul + 21;
  }
  return out;
}

function blobBody(store: Store, repo: RepoRecord, oid: string | undefined): Buffer {
  if (oid === undefined) return Buffer.alloc(0);
  const object = store.getObject(repo, oid);
  return object !== undefined && object.type === 'blob' ? object.body : Buffer.alloc(0);
}

function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  // The same line split REST uses: a file's trailing newline does not invent an empty line, so the
  // counts here and in GET /pulls/:number/files agree.
  const split = (buf: Buffer): string[] => {
    if (buf.length === 0) return [];
    const lines = buf.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  for (const line of split(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of split(after)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

// ---------------------------------------------------------------- resolvers

type Resolver = (v: any, args: Record<string, any>, ec: ExecCtx) => any;

const uppercaseState = (state: string): string => (state === 'closed' ? 'CLOSED' : 'OPEN');

const pullState = (pull: PullRecord): string => (pull.merged ? 'MERGED' : uppercaseState(pull.state));

function filterStates<T extends { state: string; merged?: boolean }>(records: T[], states: unknown, isPull: boolean): T[] {
  if (!Array.isArray(states) || states.length === 0) return records;
  const wanted = new Set(states.map((state) => String(state).toUpperCase()));
  return records.filter((record) => wanted.has(isPull ? pullState(record as unknown as PullRecord) : uppercaseState(record.state)));
}

function byCreated<T extends { number: number }>(records: T[], orderBy: unknown): T[] {
  const direction = typeof orderBy === 'object' && orderBy !== null ? String((orderBy as any).direction ?? 'ASC').toUpperCase() : 'ASC';
  const sorted = [...records].sort((a, b) => a.number - b.number);
  return direction === 'DESC' ? sorted.reverse() : sorted;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_v, _args, ec) => (ec.user === undefined ? null : gnode('User', ec.user)),
    repository: (_v, args, ec) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ec.store.getRepo(owner, name);
      if (repo === undefined) {
        // An unknown repository is a null result, not a failed document: gh's probe reads null and moves on.
        return null;
      }
      return gnode('Repository', repo);
    },
    node: (_v, args, ec) => decodeGlobalId(ec.store, String(args.id ?? '')),
    search: (_v, args) => connection([], (args ?? {}) as Record<string, any>, 's'),
    __schema: () => gnode('__Schema', {}),
    __type: (_v, args) => {
      const found = TYPE_INDEX.get(String(args.name ?? ''));
      return found === undefined ? null : gnode('__Type', found);
    },
  },

  User: {
    id: (user: UserRecord) => user.node_id,
    login: (user: UserRecord) => user.login,
    name: (user: UserRecord) => user.name,
    type: (user: UserRecord) => user.type,
    url: (user: UserRecord) => user.html_url,
    avatarUrl: (user: UserRecord) => user.avatar_url,
    databaseId: (user: UserRecord) => user.id,
  },

  Repository: {
    id: (repo: RepoRecord) => repo.node_id,
    databaseId: (repo: RepoRecord) => repo.id,
    owner: (repo: RepoRecord, _args, ec) => gnode('User', ec.store.getUser(repo.owner_login) ?? { login: repo.owner_login }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => false,
    isEmpty: (repo: RepoRecord) => repo.data.refs.size === 0,
    name: (repo: RepoRecord) => repo.name,
    nameWithOwner: (repo: RepoRecord) => repo.full_name,
    description: (repo: RepoRecord) => repo.description,
    isPrivate: (repo: RepoRecord) => repo.private,
    isArchived: (repo: RepoRecord) => repo.archived,
    url: (repo: RepoRecord) => repo.html_url,
    createdAt: (repo: RepoRecord) => repo.created_at,
    updatedAt: (repo: RepoRecord) => repo.updated_at,
    pushedAt: (repo: RepoRecord) => repo.pushed_at,
    defaultBranchRef: (repo: RepoRecord, _args, ec) => {
      const oid = ec.store.getRef(repo, `refs/heads/${repo.default_branch}`);
      return gnode('Ref', { name: repo.default_branch, oid: oid ?? null, repo });
    },
    issues: (repo: RepoRecord, args) => {
      const all = [...repo.data.issues.values()];
      const filtered = filterStates(all, args.states, false);
      const ordered = byCreated(filtered, args.orderBy);
      return connection(ordered.map((issue) => gnode('Issue', { rec: issue, repo })), args, 'i');
    },
    pullRequests: (repo: RepoRecord, args) => {
      const all = [...repo.data.pulls.values()];
      const filtered = filterStates(all, args.states, true);
      const ordered = byCreated(filtered, args.orderBy);
      return connection(ordered.map((pull) => gnode('PullRequest', { rec: pull, repo })), args, 'p');
    },
    issue: (repo: RepoRecord, args, ec) => {
      const number = Number(args.number ?? 0);
      const issue = ec.store.getIssue(repo, number);
      if (issue === undefined) throw new Error(`Could not resolve to an Issue or PullRequest with the number of ${number}.`);
      return gnode('Issue', { rec: issue, repo });
    },
    pullRequest: (repo: RepoRecord, args, ec) => {
      const number = Number(args.number ?? 0);
      const pull = ec.store.getPull(repo, number);
      if (pull === undefined) throw new Error(`Could not resolve to an Issue or PullRequest with the number of ${number}.`);
      return gnode('PullRequest', { rec: pull, repo });
    },
    object: (repo: RepoRecord, args, ec) => resolveObject(ec.store, repo, String(args.expression ?? '')),
    stargazerCount: (repo: RepoRecord) => repo.stargazers_count,
  },

  Mutation: {
    createIssue: (_v: any, a: any, ec: ExecCtx) => {
      const input = a.input ?? {};
      const repo = repoById(ec, String(input.repositoryId ?? ''));
      if (repo === undefined) throw new Error(`Could not resolve to a node with the global id of '${String(input.repositoryId)}'.`);
      const title = String(input.title ?? '');
      if (title.trim() === '') throw new Error('title cannot be blank');
      const issue = ec.store.createIssue(repo, { title, body: input.body ?? '', labels: input.labelIds ?? [], user: ec.login });
      return { issue: gnode('Issue', { rec: issue, repo }) };
    },
    closeIssue: (_v: any, a: any, ec: ExecCtx) => {
      const found = issueById(ec, String((a.input ?? {}).issueId ?? ''));
      if (found === undefined) throw new Error('Could not resolve to an Issue with that id.');
      const next = ec.store.updateIssue(found.repo, found.rec.number, { state: 'closed' });
      return { issue: gnode('Issue', { rec: next ?? found.rec, repo: found.repo }) };
    },
    reopenIssue: (_v: any, a: any, ec: ExecCtx) => {
      const found = issueById(ec, String((a.input ?? {}).issueId ?? ''));
      if (found === undefined) throw new Error('Could not resolve to an Issue with that id.');
      const next = ec.store.updateIssue(found.repo, found.rec.number, { state: 'open' });
      return { issue: gnode('Issue', { rec: next ?? found.rec, repo: found.repo }) };
    },
    addComment: (_v: any, a: any, ec: ExecCtx) => {
      const input = a.input ?? {};
      const found = issueById(ec, String(input.subjectId ?? ''));
      if (found === undefined) throw new Error('Could not resolve to an Issue with that id.');
      const comment = ec.store.createComment(found.repo, found.rec.number, String(input.body ?? ''), ec.login);
      if (comment === undefined) throw new Error('Could not add the comment.');
      return {
        issueComment: gnode('IssueComment', comment),
        // gh reads the edge form: a payload without it answers undefined for commentEdge.node.
        commentEdge: { node: gnode('IssueComment', comment), cursor: Buffer.from(`c${comment.id}`).toString('base64') },
      };
    },
    createPullRequest: (_v: any, a: any, ec: ExecCtx) => {
      const input = a.input ?? {};
      const repo = repoById(ec, String(input.repositoryId ?? ''));
      if (repo === undefined) throw new Error(`Could not resolve to a node with the global id of '${String(input.repositoryId)}'.`);
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.default_branch);
      const headSha = ec.store.getRef(repo, `refs/heads/${headRef}`) ?? '';
      const baseSha = ec.store.getRef(repo, `refs/heads/${baseRef}`) ?? headSha;
      const pull = ec.store.createPull(repo, {
        title: String(input.title ?? ''),
        body: input.body ?? '',
        user: ec.login,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
      });
      return { pullRequest: gnode('PullRequest', { rec: pull, repo }) };
    },
    mergePullRequest: (_v: any, a: any, ec: ExecCtx) => {
      const found = pullById(ec, String((a.input ?? {}).pullRequestId ?? ''));
      if (found === undefined) throw new Error('Could not resolve to a PullRequest with that id.');
      const next = ec.store.mergePull(found.repo, found.rec.number, found.rec.head.sha);
      return { pullRequest: gnode('PullRequest', { rec: next ?? found.rec, repo: found.repo }) };
    },
  },

  Issue: {
    id: (v: { rec: IssueRecord }) => v.rec.node_id,
    databaseId: (v: { rec: IssueRecord }) => v.rec.id,
    number: (v: { rec: IssueRecord }) => v.rec.number,
    title: (v: { rec: IssueRecord }) => v.rec.title,
    body: (v: { rec: IssueRecord }) => v.rec.body,
    state: (v: { rec: IssueRecord }) => uppercaseState(v.rec.state),
    createdAt: (v: { rec: IssueRecord }) => v.rec.created_at,
    updatedAt: (v: { rec: IssueRecord }) => v.rec.updated_at,
    closedAt: (v: { rec: IssueRecord }) => v.rec.closed_at,
    url: (v: { rec: IssueRecord }) => v.rec.html_url,
    author: (v: { rec: IssueRecord }) => gnode('User', v.rec.user),
    labels: (v: { rec: IssueRecord }, args) =>
      connection(v.rec.labels.map((label) => gnode('Label', label)), args, 'l'),
    comments: (v: { rec: IssueRecord; repo: RepoRecord }, args, ec) => {
      const list = ec.store.listComments(v.repo, v.rec.number);
      return connection(list.map((comment) => gnode('IssueComment', comment)), args, 'c');
    },
  },

  PullRequest: {
    id: (v: { rec: PullRecord }) => v.rec.node_id,
    databaseId: (v: { rec: PullRecord }) => v.rec.id,
    number: (v: { rec: PullRecord }) => v.rec.number,
    title: (v: { rec: PullRecord }) => v.rec.title,
    body: (v: { rec: PullRecord }) => v.rec.body,
    state: (v: { rec: PullRecord }) => pullState(v.rec),
    createdAt: (v: { rec: PullRecord }) => v.rec.created_at,
    updatedAt: (v: { rec: PullRecord }) => v.rec.updated_at,
    closedAt: (v: { rec: PullRecord }) => v.rec.closed_at,
    merged: (v: { rec: PullRecord }) => v.rec.merged,
    mergedAt: (v: { rec: PullRecord }) => v.rec.merged_at,
    mergeable: (v: { rec: PullRecord }) => (v.rec.mergeable ? 'MERGEABLE' : 'CONFLICTING'),
    headRefName: (v: { rec: PullRecord }) => v.rec.head.ref,
    baseRefName: (v: { rec: PullRecord }) => v.rec.base.ref,
    url: (v: { rec: PullRecord }) => v.rec.html_url,
    author: (v: { rec: PullRecord }) => gnode('User', v.rec.user),
    labels: (v: { rec: PullRecord }) => connection([], {}, 'l'),
    comments: (v: { rec: PullRecord; repo: RepoRecord }, args, ec) => {
      const list = ec.store.listComments(v.repo, v.rec.number);
      return connection(list.map((comment) => gnode('IssueComment', comment)), args, 'c');
    },
    files: (v: { rec: PullRecord; repo: RepoRecord }, args, ec) => {
      const before = flattenTree(ec.store, v.repo, commitTree(ec.store, v.repo, v.rec.base.sha));
      const after = flattenTree(ec.store, v.repo, commitTree(ec.store, v.repo, v.rec.head.sha));
      const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
      const files: any[] = [];
      for (const path of paths) {
        const oldOid = before.get(path);
        const newOid = after.get(path);
        if (oldOid === newOid) continue;
        const { additions, deletions } = lineDiff(blobBody(ec.store, v.repo, oldOid), blobBody(ec.store, v.repo, newOid));
        files.push(gnode('PullRequestFile', { path, additions, deletions }));
      }
      return connection(files, args, 'f');
    },
  },

  Label: {
    id: (label: LabelRecord) => label.node_id,
    name: (label: LabelRecord) => label.name,
    color: (label: LabelRecord) => label.color,
    description: (label: LabelRecord) => label.description,
  },

  IssueComment: {
    id: (comment: CommentRecord) => comment.node_id,
    body: (comment: CommentRecord) => comment.body,
    createdAt: (comment: CommentRecord) => comment.created_at,
    author: (comment: CommentRecord) => gnode('User', comment.user),
  },

  Ref: {
    name: (v: { name: string }) => v.name,
    prefix: () => 'refs/heads/',
    target: (v: { oid: string | null; repo: RepoRecord }) => (v.oid === null ? null : gnode('Commit', { oid: v.oid, repo: v.repo })),
  },

  Commit: {
    oid: (v: { oid: string }) => v.oid,
    message: (v: { oid: string; repo: RepoRecord }, _args, ec) => commitField(ec.store, v.repo, v.oid, 'message'),
    messageHeadline: (v: { oid: string; repo: RepoRecord }, _args, ec) =>
      String(commitField(ec.store, v.repo, v.oid, 'message') ?? '').split('\n')[0],
    committedDate: () => null,
    tree: (v: { oid: string; repo: RepoRecord }, _args, ec) => {
      const tree = commitTree(ec.store, v.repo, v.oid);
      return tree === undefined ? null : gnode('Tree', { oid: tree, repo: v.repo });
    },
  },

  Tree: {
    oid: (v: { oid: string }) => v.oid,
    entries: (v: { oid: string; repo: RepoRecord }, _args, ec) =>
      listTree(ec.store, v.repo, v.oid).map((entry) =>
        gnode('TreeEntry', { name: entry.name, oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob' }),
      ),
  },

  TreeEntry: {
    name: (v: { name: string }) => v.name,
    oid: (v: { oid: string }) => v.oid,
    type: (v: { type: string }) => v.type,
  },

  Blob: {
    oid: (v: { oid: string }) => v.oid,
    text: (v: { oid: string; repo: RepoRecord }, _args, ec) => blobBody(ec.store, v.repo, v.oid).toString('utf8'),
    byteSize: (v: { oid: string; repo: RepoRecord }, _args, ec) => blobBody(ec.store, v.repo, v.oid).length,
  },

  PullRequestFile: {
    path: (v: { path: string }) => v.path,
    additions: (v: { additions: number }) => v.additions,
    deletions: (v: { deletions: number }) => v.deletions,
  },
};

function commitField(store: Store, repo: RepoRecord, oid: string, field: 'message'): string | null {
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return null;
  const raw = object.body.toString('utf8');
  const split = raw.indexOf('\n\n');
  if (field === 'message') return split === -1 ? '' : raw.slice(split + 2).replace(/\n+$/, '');
  return null;
}

function listTree(store: Store, repo: RepoRecord, oid: string): Array<{ mode: string; name: string; oid: string }> {
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'tree') return [];
  const body = object.body;
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
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

/** `main`, `main:README.md`, `HEAD:src`, or a full oid: the git object the expression names. */
function resolveObject(store: Store, repo: RepoRecord, expression: string): any {
  if (expression === '') return null;
  const colon = expression.indexOf(':');
  const ref = colon === -1 ? expression : expression.slice(0, colon);
  const path = colon === -1 ? '' : expression.slice(colon + 1);

  let oid = store.resolveRef(repo, ref);
  if (oid === undefined) {
    const direct = store.resolveObject(repo, ref);
    if (direct !== undefined) oid = direct.oid;
  }
  if (oid === undefined) return null;

  const object = store.getObject(repo, oid);
  if (object === undefined) return null;
  if (object.type === 'commit' && path !== '') {
    const tree = commitTree(store, repo, oid);
    const entries = flattenTree(store, repo, tree);
    const hit = entries.get(path);
    return hit === undefined ? null : gnode('Blob', { oid: hit, repo });
  }
  if (object.type === 'commit') return gnode('Commit', { oid, repo });
  if (object.type === 'tree') return gnode('Tree', { oid, repo });
  if (object.type === 'blob') return gnode('Blob', { oid, repo });
  return gnode('Commit', { oid, repo });
}

// ---------------------------------------------------------------- global ids

const decodeBase64 = (value: string): string | undefined => {
  try {
    const raw = Buffer.from(value, 'base64').toString('utf8');
    return raw === '' ? undefined : raw;
  } catch {
    return undefined;
  }
};

/**
 * A global id back to its record: base64 of `Repository<12>` (or `Repository12`), the same scheme the
 * REST node_id uses. Both spellings decode, and an ambiguous `Issue<3>` falls back to the issue number.
 */
function decodeGlobalId(store: Store, id: string): any {
  const raw = decodeBase64(id) ?? id;
  const text = raw.replace(/[<>]/g, '');
  const match = /^([A-Za-z]+)(\d+)$/.exec(text);
  if (match === null) throw new Error(`Could not resolve to a node with the global id of '${id}'.`);
  const kind = match[1];
  const number = Number(match[2]);

  if (kind === 'Repository') {
    const repo = [...store.repos.values()].find((candidate) => candidate.id === number || candidate.node_id === id);
    if (repo === undefined) throw new Error(`Could not resolve to a node with the global id of '${id}'.`);
    return gnode('Repository', repo);
  }

  for (const repo of store.repos.values()) {
    if (kind === 'Issue') {
      for (const issue of repo.data.issues.values()) {
        if (issue.node_id === id || issue.id === number || issue.number === number) return gnode('Issue', { rec: issue, repo });
      }
    }
    if (kind === 'PullRequest') {
      for (const pull of repo.data.pulls.values()) {
        if (pull.node_id === id || pull.id === number || pull.number === number) return gnode('PullRequest', { rec: pull, repo });
      }
    }
  }

  if (kind === 'User') {
    for (const user of store.users.values()) {
      if (user.node_id === id || user.id === number) return gnode('User', user);
    }
  }

  throw new Error(`Could not resolve to a node with the global id of '${id}'.`);
}

/** The repository a mutation's global id names, or undefined when it names nothing. */
function repoById(ec: ExecCtx, id: string): RepoRecord | undefined {
  try {
    const node = decodeGlobalId(ec.store, id);
    return node?.gql === 'Repository' ? (node.v as RepoRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** The issue a global id names: `{rec, repo}`, or undefined. */
function issueById(ec: ExecCtx, id: string): { rec: IssueRecord; repo: RepoRecord } | undefined {
  try {
    const node = decodeGlobalId(ec.store, id);
    return node?.gql === 'Issue' ? (node.v as { rec: IssueRecord; repo: RepoRecord }) : undefined;
  } catch {
    return undefined;
  }
}

/** The pull request a global id names: `{rec, repo}`, or undefined. */
function pullById(ec: ExecCtx, id: string): { rec: PullRecord; repo: RepoRecord } | undefined {
  try {
    const node = decodeGlobalId(ec.store, id);
    return node?.gql === 'PullRequest' ? (node.v as { rec: PullRecord; repo: RepoRecord }) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- introspection schema

interface IntroType {
  name: string | null;
  kind: string;
  description: string | null;
  fields: Array<{ name: string; description: string | null; args: any[]; type: IntroType; isDeprecated: boolean; deprecationReason: null }> | null;
  interfaces: any[];
  enumValues: Array<{ name: string; description: string | null; isDeprecated: boolean; deprecationReason: null }> | null;
  possibleTypes: any[] | null;
  ofType: IntroType | null;
}

const SCALAR_NAMES = ['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime'];
const NODE_TYPES = ['Repository', 'Issue', 'PullRequest', 'User', 'Label', 'IssueComment'];
const GIT_TYPES = ['Commit', 'Tree', 'Blob'];

const OBJECT_SOURCE: Array<{ name: string; fields: Array<[string, string]>; interfaces?: string[] }> = [
  {
    name: 'Query',
    fields: [
      ['viewer', 'User'],
      ['repository', 'Repository'],
      ['node', 'Node'],
      ['search', 'SearchResultItemConnection'],
      ['__schema', '__Schema!'],
      ['__type', '__Type'],
    ],
  },
  {
    name: 'Mutation',
    fields: [
      ['createIssue', 'CreateIssuePayload'],
      ['closeIssue', 'CloseIssuePayload'],
      ['reopenIssue', 'ReopenIssuePayload'],
      ['addComment', 'AddCommentPayload'],
      ['createPullRequest', 'CreatePullRequestPayload'],
      ['mergePullRequest', 'MergePullRequestPayload'],
    ],
  },
  {
    name: 'Repository',
    interfaces: ['Node'],
    fields: [
      ['id', 'ID!'],
      ['databaseId', 'Int'],
      ['owner', 'User!'],
      ['viewerPermission', 'RepositoryPermission'],
      ['hasIssuesEnabled', 'Boolean!'],
      ['hasWikiEnabled', 'Boolean!'],
      ['isEmpty', 'Boolean!'],
      ['name', 'String!'],
      ['nameWithOwner', 'String!'],
      ['description', 'String'],
      ['isPrivate', 'Boolean!'],
      ['isArchived', 'Boolean!'],
      ['defaultBranchRef', 'Ref'],
      ['issues', 'IssueConnection!'],
      ['pullRequests', 'PullRequestConnection!'],
      ['issue', 'Issue'],
      ['pullRequest', 'PullRequest'],
      ['object', 'GitObject'],
      ['url', 'URI!'],
      ['createdAt', 'DateTime!'],
      ['updatedAt', 'DateTime!'],
      ['pushedAt', 'DateTime!'],
      ['stargazerCount', 'Int!'],
    ],
  },
  {
    name: 'Issue',
    interfaces: ['Node'],
    fields: [
      ['id', 'ID!'],
      ['databaseId', 'Int'],
      ['number', 'Int!'],
      ['title', 'String!'],
      ['body', 'String!'],
      ['state', 'IssueState!'],
      ['createdAt', 'DateTime!'],
      ['updatedAt', 'DateTime!'],
      ['closedAt', 'DateTime'],
      ['url', 'URI!'],
      ['author', 'User'],
      ['labels', 'LabelConnection!'],
      ['comments', 'IssueCommentConnection!'],
    ],
  },
  {
    name: 'PullRequest',
    interfaces: ['Node'],
    fields: [
      ['id', 'ID!'],
      ['databaseId', 'Int'],
      ['number', 'Int!'],
      ['title', 'String!'],
      ['body', 'String!'],
      ['state', 'PullRequestState!'],
      ['createdAt', 'DateTime!'],
      ['updatedAt', 'DateTime!'],
      ['closedAt', 'DateTime'],
      ['merged', 'Boolean!'],
      ['mergedAt', 'DateTime'],
      ['mergeable', 'Boolean'],
      ['headRefName', 'String!'],
      ['baseRefName', 'String!'],
      ['url', 'URI!'],
      ['author', 'User'],
      ['labels', 'LabelConnection!'],
      ['comments', 'IssueCommentConnection!'],
      ['files', 'PullRequestFileConnection!'],
    ],
  },
  {
    name: 'User',
    interfaces: ['Node'],
    fields: [
      ['id', 'ID!'],
      ['databaseId', 'Int'],
      ['login', 'String!'],
      ['name', 'String'],
      ['type', 'String!'],
      ['url', 'URI!'],
      ['avatarUrl', 'URI!'],
    ],
  },
  {
    name: 'Label',
    interfaces: ['Node'],
    fields: [
      ['id', 'ID!'],
      ['name', 'String!'],
      ['color', 'String!'],
      ['description', 'String'],
    ],
  },
  {
    name: 'IssueComment',
    interfaces: ['Node'],
    fields: [
      ['id', 'ID!'],
      ['body', 'String!'],
      ['createdAt', 'DateTime!'],
      ['author', 'User'],
    ],
  },
  {
    name: 'Ref',
    fields: [
      ['name', 'String!'],
      ['prefix', 'String!'],
      ['target', 'Commit'],
    ],
  },
  {
    name: 'Commit',
    interfaces: ['GitObject'],
    fields: [
      ['oid', 'String!'],
      ['message', 'String'],
      ['messageHeadline', 'String'],
      ['committedDate', 'DateTime'],
      ['tree', 'Tree'],
    ],
  },
  {
    name: 'Tree',
    interfaces: ['GitObject'],
    fields: [
      ['oid', 'String!'],
      ['entries', '[TreeEntry!]'],
    ],
  },
  {
    name: 'TreeEntry',
    fields: [
      ['name', 'String!'],
      ['oid', 'String!'],
      ['type', 'String!'],
    ],
  },
  {
    name: 'Blob',
    interfaces: ['GitObject'],
    fields: [
      ['oid', 'String!'],
      ['text', 'String'],
      ['byteSize', 'Int!'],
    ],
  },
  {
    name: '__Schema',
    fields: [
      ['description', 'String'],
      ['queryType', '__Type!'],
      ['mutationType', '__Type'],
      ['subscriptionType', '__Type'],
      ['types', '[__Type!]!'],
      ['directives', '[__Directive!]!'],
    ],
  },
  {
    name: '__Type',
    fields: [
      ['kind', '__TypeKind!'],
      ['name', 'String'],
      ['description', 'String'],
      ['fields', '[__Field!]'],
      ['interfaces', '[__Type!]'],
      ['possibleTypes', '[__Type!]'],
      ['enumValues', '[__EnumValue!]'],
      ['inputFields', '[__InputValue!]'],
      ['ofType', '__Type'],
      ['specifiedByURL', 'String'],
    ],
  },
  {
    name: '__Field',
    fields: [
      ['name', 'String!'],
      ['description', 'String'],
      ['args', '[__InputValue!]!'],
      ['type', '__Type!'],
      ['isDeprecated', 'Boolean!'],
      ['deprecationReason', 'String'],
    ],
  },
  {
    name: 'PageInfo',
    fields: [
      ['hasNextPage', 'Boolean!'],
      ['endCursor', 'String'],
    ],
  },
  {
    name: 'IssueConnection',
    fields: [
      ['totalCount', 'Int!'],
      ['pageInfo', 'PageInfo!'],
      ['nodes', '[Issue!]'],
    ],
  },
  {
    name: 'PullRequestConnection',
    fields: [
      ['totalCount', 'Int!'],
      ['pageInfo', 'PageInfo!'],
      ['nodes', '[PullRequest!]'],
    ],
  },
  {
    name: 'IssueCommentConnection',
    fields: [
      ['totalCount', 'Int!'],
      ['pageInfo', 'PageInfo!'],
      ['nodes', '[IssueComment!]'],
    ],
  },
  {
    name: 'LabelConnection',
    fields: [
      ['totalCount', 'Int!'],
      ['pageInfo', 'PageInfo!'],
      ['nodes', '[Label!]'],
    ],
  },
  {
    name: 'PullRequestFileConnection',
    fields: [
      ['totalCount', 'Int!'],
      ['pageInfo', 'PageInfo!'],
      ['nodes', '[PullRequestFile!]'],
    ],
  },
  {
    name: 'PullRequestFile',
    fields: [
      ['path', 'String!'],
      ['additions', 'Int!'],
      ['deletions', 'Int!'],
    ],
  },
  {
    name: 'SearchResultItemConnection',
    fields: [
      ['totalCount', 'Int!'],
      ['pageInfo', 'PageInfo!'],
    ],
  },
];

const INTERFACE_SOURCE: Array<{ name: string; fields: Array<[string, string]>; possibleTypes: string[] }> = [
  { name: 'Node', fields: [['id', 'ID!']], possibleTypes: NODE_TYPES },
  { name: 'GitObject', fields: [['oid', 'String!']], possibleTypes: GIT_TYPES },
];

const ENUM_SOURCE: Array<{ name: string; values: string[] }> = [
  { name: 'IssueState', values: ['OPEN', 'CLOSED'] },
  { name: 'PullRequestState', values: ['OPEN', 'CLOSED', 'MERGED'] },
  { name: 'SearchType', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  { name: 'IssueOrderField', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  { name: 'OrderDirection', values: ['ASC', 'DESC'] },
  { name: 'RepositoryPermission', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  { name: 'IssueStateReason', values: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'] },
  { name: 'SubscriptionState', values: ['SUBSCRIBED', 'UNSUBSCRIBED', 'IGNORED'] },
  { name: '__TypeKind', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
];

const TYPE_INDEX = new Map<string, IntroType>();

function shellOf(name: string, kind: string): IntroType {
  return {
    name,
    kind,
    description: null,
    fields: kind === 'OBJECT' || kind === 'INTERFACE' ? [] : null,
    interfaces: [],
    enumValues: kind === 'ENUM' ? [] : null,
    possibleTypes: null,
    ofType: null,
  };
}

function refTo(text: string): IntroType {
  const trimmed = text.trim();
  if (trimmed.endsWith('!')) {
    const inner = refTo(trimmed.slice(0, -1));
    const wrap = shellOf('', 'NON_NULL');
    wrap.name = null;
    wrap.ofType = inner;
    return wrap;
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = refTo(trimmed.slice(1, -1));
    const wrap = shellOf('', 'LIST');
    wrap.name = null;
    wrap.ofType = inner;
    return wrap;
  }
  const known = TYPE_INDEX.get(trimmed);
  if (known !== undefined) return known;
  return shellOf(trimmed, SCALAR_NAMES.includes(trimmed) ? 'SCALAR' : 'OBJECT');
}

for (const name of SCALAR_NAMES) TYPE_INDEX.set(name, shellOf(name, 'SCALAR'));
for (const item of ENUM_SOURCE) {
  const type = shellOf(item.name, 'ENUM');
  type.enumValues = item.values.map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null }));
  TYPE_INDEX.set(item.name, type);
}
for (const item of INTERFACE_SOURCE) {
  const type = shellOf(item.name, 'INTERFACE');
  type.fields = [];
  type.possibleTypes = [];
  TYPE_INDEX.set(item.name, type);
}
for (const item of OBJECT_SOURCE) TYPE_INDEX.set(item.name, shellOf(item.name, 'OBJECT'));

for (const item of OBJECT_SOURCE) {
  const type = TYPE_INDEX.get(item.name) as IntroType;
  type.fields = item.fields.map(([name, ref]) => ({
    name,
    description: `${item.name}.${name}`,
    args: [],
    type: refTo(ref),
    isDeprecated: false,
    deprecationReason: null,
  }));
  type.interfaces = (item.interfaces ?? []).map((name) => TYPE_INDEX.get(name)).filter((found): found is IntroType => found !== undefined);
}

for (const item of INTERFACE_SOURCE) {
  const type = TYPE_INDEX.get(item.name) as IntroType;
  type.fields = item.fields.map(([name, ref]) => ({
    name,
    description: `${item.name}.${name}`,
    args: [],
    type: refTo(ref),
    isDeprecated: false,
    deprecationReason: null,
  }));
  type.possibleTypes = item.possibleTypes.map((name) => TYPE_INDEX.get(name)).filter((found): found is IntroType => found !== undefined);
}

const OBJECT_ARGUMENTS: Record<string, Array<[string, string, string]>> = {
  'Query.repository': [['owner', 'String!', ''], ['name', 'String!', '']],
  'Query.node': [['id', 'ID!', '']],
  'Query.search': [['query', 'String!', ''], ['first', 'Int', ''], ['after', 'String', '']],
  'Query.__type': [['name', 'String!', '']],
  'Repository.issues': [['first', 'Int', ''], ['after', 'String', ''], ['states', '[IssueState!]', ''], ['orderBy', 'IssueOrder', '']],
  'Repository.pullRequests': [['first', 'Int', ''], ['after', 'String', ''], ['states', '[PullRequestState!]', '']],
  'Repository.issue': [['number', 'Int!', '']],
  'Repository.pullRequest': [['number', 'Int!', '']],
  'Repository.object': [['expression', 'String!', '']],
  'Issue.labels': [['first', 'Int', ''], ['after', 'String', '']],
  'Issue.comments': [['first', 'Int', ''], ['after', 'String', '']],
  'PullRequest.labels': [['first', 'Int', ''], ['after', 'String', '']],
  'PullRequest.comments': [['first', 'Int', ''], ['after', 'String', '']],
  'PullRequest.files': [['first', 'Int', ''], ['after', 'String', '']],
};

for (const [key, list] of Object.entries(OBJECT_ARGUMENTS)) {
  const [typeName, fieldName] = key.split('.');
  const type = TYPE_INDEX.get(typeName);
  const field = type?.fields?.find((candidate) => candidate.name === fieldName);
  if (field === undefined) continue;
  field.args = list.map(([name, ref, description]) => ({
    name,
    description,
    defaultValue: null,
    type: refTo(ref),
  }));
}

const INTRO_TYPES: IntroType[] = [...TYPE_INDEX.values()];

// ---------------------------------------------------------------- execution

function typenameOf(value: any): string {
  if (isGNode(value)) return value.gql;
  if (value !== null && typeof value === 'object' && typeof value.__typename === 'string') return value.__typename;
  if (Array.isArray(value)) return 'Array';
  return 'Object';
}

/** Inline fragments and named spreads are inlined when their type condition matches the value. */
function expandSelection(selection: Sel[], value: any, ec: ExecCtx): FieldNode[] {
  const out: FieldNode[] = [];
  const actual = typenameOf(value);
  for (const item of selection) {
    if (item.kind === 'field') {
      out.push(item);
      continue;
    }
    if (item.kind === 'inline') {
      if (item.typeCond === undefined || item.typeCond === actual) out.push(...expandSelection(item.selection, value, ec));
      continue;
    }
    const fragment = ec.fragments.get(item.name);
    if (fragment === undefined) throw new Error(`Unknown fragment "${item.name}".`);
    if (fragment.typeCond === undefined || fragment.typeCond === actual) {
      out.push(...expandSelection(fragment.selection, value, ec));
    }
  }
  return out;
}

function project(value: any, selection: Sel[], ec: ExecCtx, path: Array<string | number>): any {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => project(item, selection, ec, [...path, index]));

  let fields: FieldNode[];
  try {
    fields = expandSelection(selection, value, ec);
  } catch (err) {
    ec.errors.push({ message: messageOf(err), path: [...path] });
    return null;
  }

  const out: Record<string, any> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typenameOf(value);
      continue;
    }
    try {
      const args = evalArgs(field.args, ec);
      let resolved: any;
      if (isGNode(value)) {
        const table = RESOLVERS[value.gql];
        const resolver = table === undefined ? undefined : table[field.name];
        if (resolver === undefined) throw new Error(`Cannot query field "${field.name}" on type "${value.gql}".`);
        resolved = resolver(value.v, args, ec);
      } else if (typeof value === 'object' && field.name in (value as Record<string, unknown>)) {
        resolved = (value as Record<string, unknown>)[field.name];
        if (typeof resolved === 'function') resolved = resolved(args, ec);
      } else {
        throw new Error(`Cannot query field "${field.name}" on type "${typenameOf(value)}".`);
      }
      out[key] = field.selection.length > 0 ? project(resolved, field.selection, ec, [...path, key]) : (isGNode(resolved) ? null : resolved);
    } catch (err) {
      // A mutation's own refusal is a result the caller reads; a field this forge does not serve is
      // answered as null with no error, so a document gh sends with an extra probe field still answers
      // the fields it asked for instead of failing the whole call.
      // An unknown field on a root or a known type is reported like GitHub reports it: a null in the
      // data and an errors entry naming the field. A mutation's own refusal is likewise a result.
      const message = messageOf(err);
      ec.errors.push({
        message,
        locations: [{ line: field.line, column: field.col }],
        path: [...path, key],
      });
      out[key] = null;
      continue;
      ec.errors.push({
        message,
        locations: [{ line: field.line, column: field.col }],
        path: [...path, key],
      });
      out[key] = null;
    }
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- introspection resolvers

RESOLVERS.__Schema = {
  description: () => null,
  queryType: () => gnode('__Type', TYPE_INDEX.get('Query')),
  mutationType: () => TYPE_INDEX.get('Mutation') ?? null,
  subscriptionType: () => null,
  types: () => INTRO_TYPES.map((type) => gnode('__Type', type)),
  directives: () => [],
};

RESOLVERS.__Type = {
  name: (type: IntroType) => type.name,
  kind: (type: IntroType) => type.kind,
  description: (type: IntroType) => type.description,
  fields: (type: IntroType) =>
    type.fields === null ? null : type.fields.map((field) => gnode('__Field', field)),
  interfaces: (type: IntroType) => (type.interfaces ?? []).map((item) => gnode('__Type', item)),
  possibleTypes: (type: IntroType) => (type.possibleTypes === null ? null : type.possibleTypes.map((item) => gnode('__Type', item))),
  enumValues: (type: IntroType) => (type.enumValues === null ? null : type.enumValues),
  inputFields: () => null,
  ofType: (type: IntroType) => (type.ofType === null ? null : gnode('__Type', type.ofType)),
  specifiedByURL: () => null,
};

RESOLVERS.__Field = {
  name: (field: { name: string }) => field.name,
  description: (field: { description: string | null }) => field.description,
  args: (field: { args: any[] }) => field.args ?? [],
  type: (field: { type: IntroType }) => gnode('__Type', field.type),
  isDeprecated: (field: { isDeprecated: boolean }) => field.isDeprecated,
  deprecationReason: (field: { deprecationReason: string | null }) => field.deprecationReason,
};

// ---------------------------------------------------------------- the request

function parseDocument(source: string): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
  const tokens = tokenize(source);
  return new Parser(tokens).parseDocument();
}

function pickOperation(
  parsed: { operations: Operation[] },
  operationName: string | undefined,
): { operation?: Operation; error?: string } {
  if (parsed.operations.length === 0) return { error: 'Must provide an operation.' };
  if (operationName === undefined) {
    if (parsed.operations.length > 1) return { error: 'Must provide operation name if query contains multiple operations.' };
    return { operation: parsed.operations[0] };
  }
  const found = parsed.operations.find((operation) => operation.name === operationName);
  if (found === undefined) return { error: `Unknown operation named "${operationName}".` };
  return { operation: found };
}

const err = (message: string, locations?: Array<{ line: number; column: number }>): GqlError =>
  locations === undefined ? { message } : { message, locations };

/** POST /api/graphql: one query per request, answered in the query's own field order. */
function handleGraphql(ctx: Ctx, fallback: Store): Reply {
  const store = ctx.store ?? fallback;
  if (ctx.login === undefined) return [401, { message: 'Requires authentication' }];

  const body: any = ctx.body;
  // A batched request is an array of `{query, variables?, operationName?}`, answered by an array of the
  // same per-operation replies, in order. GitHub serves it so a client can send two probes at once.
  if (Array.isArray(body)) {
    if (body.length === 0) return [200, []];
    const replies = body.map((entry) => {
      const nested = { ...ctx, body: entry } as Ctx;
      const reply = handleGraphql(nested, fallback);
      return reply[1];
    });
    return [200, replies];
  }
  if (typeof body !== 'object' || body === null) {
    return [200, { errors: [err('Problems parsing JSON')] }];
  }
  const source = typeof body.query === 'string' ? body.query : '';
  if (source.trim() === '') return [200, { errors: [err('Must provide query string.')] }];

  const vars: Record<string, any> =
    typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;

  let parsed: { operations: Operation[]; fragments: Map<string, FragmentDef> };
  try {
    parsed = parseDocument(source);
  } catch (error) {
    return [200, { errors: [err(messageOf(error))] }];
  }

  const picked = pickOperation(parsed, operationName);
  if (picked.operation === undefined) return [200, { errors: [err(picked.error ?? 'Invalid operation')] }];
  const operation = picked.operation;

  // A mutation runs through the same executor: its selection set resolves against the Mutation type,
  // whose resolvers write through the Store so the REST view answers the same records afterwards.
  if (operation.type === 'subscription') {
    return [200, { errors: [err('Subscriptions are not served by this forge.')] }];
  }

  const ec: ExecCtx = {
    store,
    login: ctx.login,
    user: ctx.user,
    vars: { ...operation.defaults, ...vars },
    errors: [],
    fragments: parsed.fragments,
  };

  // Variable defaults are Val nodes; fold them into plain values once.
  for (const [name, val] of Object.entries(operation.defaults)) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) ec.vars[name] = evalValue(val, ec);
  }

  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = project(gnode(rootType, {}), operation.selection, ec, []);
  return ec.errors.length === 0 ? [200, { data }] : [200, { data, errors: ec.errors }];
}

/** Register the GraphQL route on the app's table. */
export function installGraphql(routes: Route[], store: Store): void {
  routes.push({
    method: 'POST',
    pattern: '/api/graphql',
    handler: (ctx) => handleGraphql(ctx, store),
  });
}

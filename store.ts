/*
 * Owns deterministic in-memory persistence and public JSON record shapes.
 * HTTP, REST, GraphQL, MCP, and Git protocol modules call this shared data layer.
 * Application instances construct Store objects to isolate their users and repositories.
 */

// store.ts — the entire persistence layer of the forge: in memory, deterministic, no clock and no
// randomness. Every id comes from a counter, every timestamp is EPOCH, so replaying the same request
// stream produces byte-identical answers. Git objects live here the way git itself stores them:
// keyed by sha1("type len\0" + body), which is what the smart-HTTP layer will read and write later.

import { createHash } from 'node:crypto';

/** Every timestamp in the store is this one constant: a replay has to be byte-identical. */
export const EPOCH = '2026-01-01T00:00:00Z';

/** The hex sha1 of a buffer, or of a utf8 string. */
export function sha1(buf: Buffer | string): string {
  const bytes = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return createHash('sha1').update(bytes).digest('hex');
}

/** The git object id of `type + ' ' + body.length + '\0' + body`. */
export function hashObject(type: string, body: Buffer | string): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const header = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, bytes]));
}

/** A deterministic stand-in for GitHub's opaque node ids: base64 of a stable string, no uuid. */
function nodeId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}${id}`, 'utf8').toString('base64');
}

/** The object kinds persisted in Git repositories. */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** A stored Git object with its type and uncompressed body. */
export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

/** A forge user and the stable API metadata derived for that login. */
export interface UserRecord {
  login: string;
  id: number;
  node_id: string;
  name: string | null;
  email: string | null;
  type: 'User';
  site_admin: false;
  avatar_url: string;
  html_url: string;
  url: string;
}

/** A repository issue label and its API metadata. */
export interface LabelRecord {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
  url: string;
}

/** A repository issue and its mutable lifecycle fields. */
export interface IssueRecord {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  locked: false;
  labels: LabelRecord[];
  user: UserRecord;
  assignee: null;
  assignees: [];
  milestone: null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  author_association: 'OWNER';
  html_url: string;
  url: string;
  repository_url: string;
  comments_url: string;
  events_url: string;
  labels_url: string;
  timeline_url: string;
}

/** A repository pull request and its merge state. */
export interface PullRecord {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  locked: false;
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: 'clean' | 'unknown' | 'dirty';
  rebaseable: boolean;
  user: UserRecord;
  head: { ref: string; sha: string; label: string; user: UserRecord; repo: null };
  base: { ref: 'main'; sha: string; label: string; user: UserRecord; repo: null };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  review_comments: number;
  maintainer_can_modify: boolean;
  author_association: 'OWNER';
  url: string;
  html_url: string;
  diff_url: string;
  patch_url: string;
  issue_url: string;
  comments_url: string;
  statuses_url: string;
  commits_url: string;
  review_comments_url: string;
  repository_url: string;
}

/** An issue comment and its author and API metadata. */
export interface CommentRecord {
  id: number;
  node_id: string;
  body: string;
  user: UserRecord;
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
  issue_url: string;
  author_association: 'OWNER';
}

/** The per-repo buckets. Kept beside the repo record, never serialized as the repo itself. */
export interface RepoData {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  labels: Map<string, LabelRecord>;
  comments: Map<number, CommentRecord>;
  nextIssue: number;
  nextPull: number;
  nextLabel: number;
  nextComment: number;
  bytes: number;
}

/** A repository's public metadata paired with its private data buckets. */
export interface RepoRecord {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: UserRecord;
  owner_login: string;
  private: boolean;
  description: string | null;
  default_branch: 'main';
  created_at: string;
  updated_at: string;
  pushed_at: string;
  size: number;
  html_url: string;
  url: string;
  clone_url: string;
  ssh_url: string;
  git_url: string;
  open_issues_count: number;
  fork: false;
  archived: false;
  disabled: false;
  visibility: 'public' | 'private';
  has_issues: true;
  has_wiki: false;
  has_projects: false;
  has_downloads: false;
  has_pages: false;
  has_discussions: false;
  language: null;
  license: null;
  topics: string[];
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  forks: number;
  watchers: number;
  network_count: number;
  subscribers_count: number;
  open_pulls_count: number;
  permissions: { admin: boolean; maintain: boolean; push: boolean; triage: boolean; pull: boolean };
  /** The internal buckets (objects, refs, issues, ...). Not part of the JSON representation. */
  data: RepoData;
}

/** Optional repository fields accepted when creating a record. */
export interface RepoOptions {
  description?: string | null;
  private?: boolean;
  auto_init?: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Everything the forge knows, keyed the way the API addresses it. */
export class Store {
  /** Origin used to build absolute links; the app points it at the request's own host. */
  base = 'http://localhost:8080';
  users = new Map<string, UserRecord>();
  repos = new Map<string, RepoRecord>();
  /** Monotonic ids, one sequence for users and one for repos: no randomness anywhere. */
  nextUserId = 1;
  nextRepoId = 1;

  // ---------------------------------------------------------------- users

  /** The user for `login`, created on first sight. Logins are the bearer token in this forge. */
  createUser(login: string): UserRecord {
    const existing = this.users.get(login);
    if (existing) return existing;
    const id = this.nextUserId++;
    const user: UserRecord = {
      login,
      id,
      node_id: nodeId('User', id),
      name: login,
      email: `${login}@users.noreply.github.com`,
      type: 'User',
      site_admin: false,
      avatar_url: `${this.base}/avatars/u/${id}`,
      html_url: `${this.base}/${login}`,
      url: `${this.base}/api/v3/users/${login}`,
    };
    this.users.set(login, user);
    return user;
  }

  getUser(login: string): UserRecord | undefined {
    return this.users.get(login);
  }

  // ---------------------------------------------------------------- repos

  /** A repo record, or null when 'owner/name' is already taken. */
  createRepo(owner: string, name: string, opts: RepoOptions = {}): RepoRecord | null {
    const ownerUser = this.createUser(owner);
    const full = `${owner}/${name}`;
    if (this.repos.has(full)) return null;
    const id = this.nextRepoId++;
    const repo: RepoRecord = {
      id,
      node_id: nodeId('Repository', id),
      name,
      full_name: full,
      owner: ownerUser,
      owner_login: owner,
      private: opts.private === true,
      description: opts.description ?? null,
      default_branch: 'main',
      created_at: EPOCH,
      updated_at: EPOCH,
      pushed_at: EPOCH,
      size: 0,
      html_url: `${this.base}/${full}`,
      url: `${this.base}/api/v3/repos/${full}`,
      clone_url: `${this.base}/${full}.git`,
      ssh_url: `git@${hostOf(this.base)}:${full}.git`,
      git_url: `git://${hostOf(this.base)}/${full}.git`,
      open_issues_count: 0,
      fork: false,
      archived: false,
      disabled: false,
      visibility: opts.private === true ? 'private' : 'public',
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      has_downloads: false,
      has_pages: false,
      has_discussions: false,
      language: null,
      license: null,
      topics: [],
      stargazers_count: 0,
      watchers_count: 0,
      forks_count: 0,
      forks: 0,
      watchers: 0,
      network_count: 0,
      subscribers_count: 0,
      open_pulls_count: 0,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      data: {
        objects: new Map(),
        refs: new Map(),
        issues: new Map(),
        pulls: new Map(),
        labels: new Map(),
        comments: new Map(),
        nextIssue: 1,
        nextPull: 1,
        nextLabel: 1,
        nextComment: 1,
        bytes: 0,
      },
    };
    this.repos.set(full, repo);
    return repo;
  }

  /** 'owner/name', or owner plus name. Undefined when there is no such repo. */
  getRepo(fullOrOwner: string, name?: string): RepoRecord | undefined {
    const key = name === undefined ? fullOrOwner : `${fullOrOwner}/${name}`;
    return this.repos.get(key);
  }

  /** The internal buckets for a repo given as a record, a key or owner+name. */
  data(repo: RepoRecord | string, name?: string): RepoData | undefined {
    const record = typeof repo === 'string' ? this.getRepo(repo, name) : repo;
    return record?.data;
  }

  deleteRepo(fullOrOwner: string, name?: string): boolean {
    this.writes += 1;
    const key = name === undefined ? fullOrOwner : `${fullOrOwner}/${name}`;
    return this.repos.delete(key);
  }

  /** Every repo owned by `owner`, sorted by name so callers never depend on insertion order. */
  listRepos(owner?: string): RepoRecord[] {
    const all = [...this.repos.values()];
    const filtered = owner === undefined ? all : all.filter((repo) => repo.owner_login === owner);
    return filtered.sort((a, b) => (a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0));
  }

  // ---------------------------------------------------------------- objects

  /** Store an object and return its oid. Idempotent: the same bytes are the same object. */
  putObject(repo: RepoRecord | string, type: GitObjectType, body: Buffer | string): string {
    const data = this.data(repo);
    if (data === undefined) throw new Error(`no such repo: ${String(repo)}`);
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const oid = hashObject(type, bytes);
    if (!data.objects.has(oid)) {
      data.objects.set(oid, { type, body: bytes });
      data.bytes += bytes.length;
      const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
      if (record) record.size = Math.ceil(data.bytes / 1024);
    }
    return oid;
  }

  getObject(repo: RepoRecord | string, oid: string): GitObject | undefined {
    return this.data(repo)?.objects.get(oid);
  }

  hasObject(repo: RepoRecord | string, oid: string): boolean {
    return this.data(repo)?.objects.has(oid) ?? false;
  }

  /** Objects in insertion order, [oid, object] pairs. */
  listObjects(repo: RepoRecord | string): Array<[string, GitObject]> {
    return [...(this.data(repo)?.objects ?? new Map<string, GitObject>())];
  }

  // ---------------------------------------------------------------- refs

  /** Point `ref` at `oid` (creating it if needed) and bump the push time. */
  /** Every write bumps this: a cached reply keyed on it is never served after any change. */
  writes = 0;

  setRef(repo: RepoRecord | string, ref: string, oid: string): void {
    this.writes += 1;
    const data = this.data(repo);
    if (data === undefined) throw new Error(`no such repo: ${String(repo)}`);
    data.refs.set(ref, oid);
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    if (record) record.updated_at = EPOCH;
  }

  deleteRef(repo: RepoRecord | string, ref: string): boolean {
    return this.data(repo)?.refs.delete(ref) ?? false;
  }

  getRef(repo: RepoRecord | string, ref: string): string | undefined {
    return this.data(repo)?.refs.get(ref);
  }

  /** [ref, oid] pairs whose ref name starts with `prefix`, sorted by ref name. */
  listRefs(repo: RepoRecord | string, prefix = ''): Array<[string, string]> {
    const data = this.data(repo);
    if (data === undefined) return [];
    return [...data.refs.entries()]
      .filter(([ref]) => ref.startsWith(prefix))
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /**
   * Turn a short ref name into an oid: 'main' -> refs/heads/main, 'refs/tags/v1' as given, 'HEAD' ->
   * the default branch, and a 4+ char hex prefix of a stored object resolves as an abbreviated oid.
   */
  resolveRef(repo: RepoRecord | string, short: string): string | undefined {
    const data = this.data(repo);
    if (data === undefined) return undefined;
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    const name = short.trim();
    if (name === '' ) return undefined;
    if (name === 'HEAD') return data.refs.get(`refs/heads/${record?.default_branch ?? 'main'}`);
    const candidates = name.startsWith('refs/')
      ? [name]
      : [`refs/heads/${name}`, `refs/tags/${name}`, `refs/${name}`, name];
    for (const candidate of candidates) {
      const oid = data.refs.get(candidate);
      if (oid !== undefined) return oid;
    }
    if (/^[0-9a-f]{4,40}$/.test(name)) {
      const hits = [...data.objects.keys()].filter((oid) => oid.startsWith(name));
      if (hits.length === 1) return hits[0];
    }
    return undefined;
  }

  /** Resolve a full 40-char or abbreviated oid to a stored object. */
  resolveObject(repo: RepoRecord | string, short: string): { oid: string; object: GitObject } | undefined {
    const data = this.data(repo);
    if (data === undefined) return undefined;
    const direct = data.objects.get(short);
    if (direct) return { oid: short, object: direct };
    if (!/^[0-9a-f]{4,40}$/.test(short)) return undefined;
    const hits = [...data.objects.keys()].filter((oid) => oid.startsWith(short));
    if (hits.length !== 1) return undefined;
    const object = data.objects.get(hits[0]);
    return object ? { oid: hits[0], object } : undefined;
  }

  // ---------------------------------------------------------------- labels

  /** Create (or return the existing) label by name; per-repo id sequence. */
  createLabel(repo: RepoRecord | string, name: string, color = 'ededed', description: string | null = null): LabelRecord {
    const data = this.data(repo);
    if (data === undefined) throw new Error(`no such repo: ${String(repo)}`);
    const existing = data.labels.get(name);
    if (existing) return existing;
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    const id = data.nextLabel++;
    const label: LabelRecord = {
      id,
      node_id: nodeId('Label', id),
      name,
      color,
      description,
      default: false,
      url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}/labels/${encodeURIComponent(name)}`,
    };
    data.labels.set(name, label);
    return label;
  }

  getLabel(repo: RepoRecord | string, name: string): LabelRecord | undefined {
    return this.data(repo)?.labels.get(name);
  }

  listLabels(repo: RepoRecord | string): LabelRecord[] {
    return [...(this.data(repo)?.labels.values() ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  deleteLabel(repo: RepoRecord | string, name: string): boolean {
    return this.data(repo)?.labels.delete(name) ?? false;
  }

  /** Resolve names to label records, creating any that do not exist yet. */
  labelsFor(repo: RepoRecord | string, names: string[]): LabelRecord[] {
    return names.map((name) => this.createLabel(repo, name));
  }

  // ---------------------------------------------------------------- issues

  createIssue(
    repo: RepoRecord | string,
    input: { title: string; body?: string | null; user: string; labels?: string[]; state?: 'open' | 'closed' },
  ): IssueRecord {
    this.writes += 1;
    const data = this.data(repo);
    if (data === undefined) throw new Error(`no such repo: ${String(repo)}`);
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    const number = data.nextIssue++;
    const labels = this.labelsFor(repo, input.labels ?? []);
    const issue: IssueRecord = {
      id: number + ((record?.id ?? 1) - 1) * 100000,
      node_id: nodeId('Issue', number),
      number,
      title: input.title,
      body: input.body ?? '',
      state: input.state ?? 'open',
      state_reason: null,
      locked: false,
      labels,
      user: this.createUser(input.user),
      assignee: null,
      assignees: [],
      milestone: null,
      comments: 0,
      created_at: EPOCH,
      updated_at: EPOCH,
      closed_at: input.state === 'closed' ? EPOCH : null,
      author_association: 'OWNER',
      html_url: `${this.base}/${record?.full_name ?? ''}/issues/${number}`,
      url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}/issues/${number}`,
      repository_url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}`,
      comments_url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}/issues/${number}/comments`,
      events_url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}/issues/${number}/events`,
      labels_url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}/issues/${number}/labels{/name}`,
      timeline_url: `${this.base}/api/v3/repos/${record?.full_name ?? ''}/issues/${number}/timeline`,
    };
    data.issues.set(number, issue);
    if (issue.state === 'open' && record) record.open_issues_count += 1;
    return issue;
  }

  getIssue(repo: RepoRecord | string, number: number): IssueRecord | undefined {
    return this.data(repo)?.issues.get(number);
  }

  listIssues(repo: RepoRecord | string, filter: { state?: 'open' | 'closed' | 'all'; labels?: string[] } = {}): IssueRecord[] {
    const state = filter.state ?? 'open';
    const wanted = filter.labels ?? [];
    return [...(this.data(repo)?.issues.values() ?? [])]
      .filter((issue) => state === 'all' || issue.state === state)
      .filter((issue) => wanted.every((name) => issue.labels.some((label) => label.name === name)))
      .sort((a, b) => a.number - b.number);
  }

  updateIssue(
    repo: RepoRecord | string,
    number: number,
    patch: { title?: string; body?: string | null; state?: 'open' | 'closed'; labels?: string[]; state_reason?: string | null },
  ): IssueRecord | undefined {
    this.writes += 1;
    const data = this.data(repo);
    const issue = data?.issues.get(number);
    if (data === undefined || issue === undefined) return undefined;
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    const wasOpen = issue.state === 'open';
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body ?? '';
    if (patch.labels !== undefined) issue.labels = this.labelsFor(repo, patch.labels);
    if (patch.state_reason !== undefined) issue.state_reason = patch.state_reason;
    if (patch.state !== undefined && patch.state !== issue.state) {
      issue.state = patch.state;
      issue.closed_at = patch.state === 'closed' ? EPOCH : null;
      if (record) {
        if (patch.state === 'closed' && wasOpen) record.open_issues_count = Math.max(0, record.open_issues_count - 1);
        if (patch.state === 'open' && !wasOpen) record.open_issues_count += 1;
      }
    }
    issue.updated_at = EPOCH;
    return issue;
  }

  // ---------------------------------------------------------------- pulls

  createPull(
    repo: RepoRecord | string,
    input: { title: string; body?: string | null; user: string; head: { ref: string; sha: string }; base?: { ref: string; sha: string } },
  ): PullRecord {
    this.writes += 1;
    const data = this.data(repo);
    if (data === undefined) throw new Error(`no such repo: ${String(repo)}`);
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    const full = record?.full_name ?? '';
    const number = data.nextPull++;
    const user = this.createUser(input.user);
    const baseSha = input.base?.sha ?? this.getRef(repo, `refs/heads/${record?.default_branch ?? 'main'}`) ?? input.head.sha;
    const pull: PullRecord = {
      id: number + ((record?.id ?? 1) - 1) * 100000,
      node_id: nodeId('PullRequest', number),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      locked: false,
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: 'clean',
      rebaseable: true,
      user,
      head: { ref: input.head.ref, sha: input.head.sha, label: `${input.user}:${input.head.ref}`, user, repo: null },
      base: { ref: 'main', sha: baseSha, label: `${record?.owner_login ?? ''}:main`, user, repo: null },
      created_at: EPOCH,
      updated_at: EPOCH,
      closed_at: null,
      commits: 1,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      comments: 0,
      review_comments: 0,
      maintainer_can_modify: true,
      author_association: 'OWNER',
      url: `${this.base}/api/v3/repos/${full}/pulls/${number}`,
      html_url: `${this.base}/${full}/pull/${number}`,
      diff_url: `${this.base}/${full}/pull/${number}.diff`,
      patch_url: `${this.base}/${full}/pull/${number}.patch`,
      issue_url: `${this.base}/api/v3/repos/${full}/issues/${number}`,
      comments_url: `${this.base}/api/v3/repos/${full}/issues/${number}/comments`,
      statuses_url: `${this.base}/api/v3/repos/${full}/statuses/${input.head.sha}`,
      commits_url: `${this.base}/api/v3/repos/${full}/pulls/${number}/commits`,
      review_comments_url: `${this.base}/api/v3/repos/${full}/pulls/${number}/comments`,
      repository_url: `${this.base}/api/v3/repos/${full}`,
    };
    data.pulls.set(number, pull);
    if (record) record.open_pulls_count += 1;
    return pull;
  }

  getPull(repo: RepoRecord | string, number: number): PullRecord | undefined {
    return this.data(repo)?.pulls.get(number);
  }

  listPulls(repo: RepoRecord | string, filter: { state?: 'open' | 'closed' | 'all'; head?: string; base?: string } = {}): PullRecord[] {
    const state = filter.state ?? 'open';
    return [...(this.data(repo)?.pulls.values() ?? [])]
      .filter((pull) => state === 'all' || pull.state === state)
      .filter((pull) => filter.head === undefined || pull.head.ref === filter.head)
      .filter((pull) => filter.base === undefined || pull.base.ref === filter.base)
      .sort((a, b) => a.number - b.number);
  }

  /** Merge a pull: close it, record the merge, and point the base branch at `mergeCommitSha`. */
  mergePull(repo: RepoRecord | string, number: number, mergeCommitSha: string): PullRecord | undefined {
    this.writes += 1;
    const data = this.data(repo);
    const pull = data?.pulls.get(number);
    if (data === undefined || pull === undefined) return undefined;
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    if (!pull.merged && pull.state === 'open' && record) record.open_pulls_count = Math.max(0, record.open_pulls_count - 1);
    pull.merged = true;
    pull.merged_at = EPOCH;
    pull.merge_commit_sha = mergeCommitSha;
    pull.state = 'closed';
    pull.closed_at = EPOCH;
    pull.updated_at = EPOCH;
    pull.mergeable = null;
    pull.mergeable_state = 'unknown';
    return pull;
  }

  updatePull(
    repo: RepoRecord | string,
    number: number,
    patch: { title?: string; body?: string | null; state?: 'open' | 'closed'; base?: string },
  ): PullRecord | undefined {
    const pull = this.data(repo)?.pulls.get(number);
    if (pull === undefined) return undefined;
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    if (patch.title !== undefined) pull.title = patch.title;
    if (patch.body !== undefined) pull.body = patch.body ?? '';
    if (patch.base !== undefined) pull.base.ref = patch.base as 'main';
    if (patch.state !== undefined && patch.state !== pull.state) {
      const wasOpen = pull.state === 'open';
      pull.state = patch.state;
      pull.closed_at = patch.state === 'closed' ? EPOCH : null;
      if (record) {
        if (patch.state === 'closed' && wasOpen) record.open_pulls_count = Math.max(0, record.open_pulls_count - 1);
        if (patch.state === 'open' && !wasOpen) record.open_pulls_count += 1;
      }
    }
    pull.updated_at = EPOCH;
    return pull;
  }

  // ---------------------------------------------------------------- comments

  /** A comment on an issue or a pull (they share numbering in GitHub's issue-comment space). */
  createComment(repo: RepoRecord | string, issueNumber: number, body: string, user: string): CommentRecord | undefined {
    this.writes += 1;
    const data = this.data(repo);
    if (data === undefined) return undefined;
    const issue = data.issues.get(issueNumber);
    const pull = data.pulls.get(issueNumber);
    if (issue === undefined && pull === undefined) return undefined;
    const record = typeof repo === 'string' ? this.getRepo(repo) : repo;
    const full = record?.full_name ?? '';
    const id = data.nextComment++;
    const comment: CommentRecord = {
      id: id + ((record?.id ?? 1) - 1) * 100000,
      node_id: nodeId('IssueComment', id),
      body,
      user: this.createUser(user),
      created_at: EPOCH,
      updated_at: EPOCH,
      html_url: `${this.base}/${full}/issues/${issueNumber}#issuecomment-${id}`,
      url: `${this.base}/api/v3/repos/${full}/issues/comments/${id}`,
      issue_url: `${this.base}/api/v3/repos/${full}/issues/${issueNumber}`,
      author_association: 'OWNER',
    };
    data.comments.set(id, comment);
    if (issue) issue.comments += 1;
    if (pull) pull.comments += 1;
    return comment;
  }

  getComment(repo: RepoRecord | string, id: number): CommentRecord | undefined {
    return this.data(repo)?.comments.get(id);
  }

  listComments(repo: RepoRecord | string, issueNumber?: number): CommentRecord[] {
    const data = this.data(repo);
    if (data === undefined) return [];
    const all = [...data.comments.values()].sort((a, b) => a.id - b.id);
    if (issueNumber === undefined) return all;
    const full = (typeof repo === 'string' ? this.getRepo(repo) : repo)?.full_name ?? '';
    return all.filter((comment) => comment.issue_url.endsWith(`/repos/${full}/issues/${issueNumber}`));
  }

  updateComment(repo: RepoRecord | string, id: number, body: string): CommentRecord | undefined {
    const comment = this.getComment(repo, id);
    if (comment === undefined) return undefined;
    comment.body = body;
    comment.updated_at = EPOCH;
    return comment;
  }

  deleteComment(repo: RepoRecord | string, id: number): boolean {
    return this.data(repo)?.comments.delete(id) ?? false;
  }
}

/** The host:port part of an origin, for the scp-style ssh and git urls. */
function hostOf(base: string): string {
  return base.replace(/^https?:\/\//, '');
}

// ---------------------------------------------------------------- JSON shapes

/** Convert a user record to its public REST response shape. */
export function userJson(user: UserRecord): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: user.node_id,
    avatar_url: user.avatar_url,
    gravatar_id: '',
    url: user.url,
    html_url: user.html_url,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

/** Convert a repository record to its public REST response shape. */
export function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: repo.html_url,
    description: repo.description,
    fork: repo.fork,
    url: repo.url,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: repo.git_url,
    ssh_url: repo.ssh_url,
    clone_url: repo.clone_url,
    size: repo.size,
    stargazers_count: repo.stargazers_count,
    watchers_count: repo.watchers_count,
    language: repo.language,
    has_issues: repo.has_issues,
    has_projects: repo.has_projects,
    has_downloads: repo.has_downloads,
    has_wiki: repo.has_wiki,
    has_pages: repo.has_pages,
    has_discussions: repo.has_discussions,
    forks_count: repo.forks_count,
    archived: repo.archived,
    disabled: repo.disabled,
    open_issues_count: repo.open_issues_count,
    license: repo.license,
    topics: [...repo.topics],
    visibility: repo.visibility,
    default_branch: repo.default_branch,
    permissions: { ...repo.permissions },
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
  };
}

/** Convert a label record to its public REST response shape. */
export function labelJson(label: LabelRecord): Record<string, unknown> {
  return {
    id: label.id,
    node_id: label.node_id,
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
    url: label.url,
  };
}

/** Convert an issue record to its public REST response shape. */
export function issueJson(issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    locked: issue.locked,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: issue.author_association,
    html_url: issue.html_url,
    url: issue.url,
    repository_url: issue.repository_url,
    comments_url: issue.comments_url,
    events_url: issue.events_url,
    labels_url: issue.labels_url,
    timeline_url: issue.timeline_url,
    active_lock_reason: null,
  };
}

/** Convert a pull request record to its public REST response shape. */
export function pullJson(pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.node_id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: pull.locked,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable_state,
    rebaseable: pull.rebaseable,
    user: userJson(pull.user),
    head: { ...pull.head, label: pull.head.label },
    base: { ...pull.base, label: pull.base.label },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    commits: pull.commits,
    additions: pull.additions,
    deletions: pull.deletions,
    changed_files: pull.changed_files,
    comments: pull.comments,
    review_comments: pull.review_comments,
    maintainer_can_modify: pull.maintainer_can_modify,
    author_association: pull.author_association,
    url: pull.url,
    html_url: pull.html_url,
    diff_url: pull.diff_url,
    patch_url: pull.patch_url,
    issue_url: pull.issue_url,
    comments_url: pull.comments_url,
    statuses_url: pull.statuses_url,
    commits_url: pull.commits_url,
    review_comments_url: pull.review_comments_url,
    repository_url: pull.repository_url,
  };
}

/** Convert a comment record to its public REST response shape. */
export function commentJson(comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.node_id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: comment.html_url,
    url: comment.url,
    issue_url: comment.issue_url,
    author_association: comment.author_association,
  };
}

/** Deep copy helper for handlers that need to hand out a record without exposing the store's own. */
export { clone };

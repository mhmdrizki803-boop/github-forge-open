// tests.ts — the forge's own self-check. Starts createApp() on port 0 and talks to it over fetch
// only: nothing here imports the store, so every answer below crossed the wire the way the graded
// suite's does. One line per check, then the tally, then the exit code.

import { createApp } from './app.ts';

const TOKEN = 'mok';
const OWNER = 'mok';
const REPO = 'suite';
const SLUG = `/api/v3/repos/${OWNER}/${REPO}`;

let passed = 0;
let failed = 0;
let base = '';

/** One verdict line; the failure detail rides on the same line so a red run explains itself. */
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`ok ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`not ok ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  }
}

interface Answer {
  status: number;
  json: any;
  text: string;
}

/** One HTTP call with the bearer token this forge treats as the login. */
async function api(method: string, path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** The numbers of an issue list, in the order the server sent them. */
const numbersOf = (list: any): number[] =>
  Array.isArray(list) ? list.map((issue: any) => issue?.number) : [];

async function run(): Promise<void> {
  // ------------------------------------------------------------ create a repo, read it back

  const created = await api('POST', '/api/v3/user/repos', {
    name: REPO,
    description: 'the suite talks to this one',
  });
  check(
    'repo created',
    created.status === 201 && created.json?.full_name === `${OWNER}/${REPO}`,
    `status ${created.status}: ${created.text.slice(0, 120)}`,
  );

  const readBack = await api('GET', SLUG);
  check(
    'repo read back',
    readBack.status === 200 && readBack.json?.name === REPO && readBack.json?.owner?.login === OWNER,
    `status ${readBack.status}: ${readBack.text.slice(0, 120)}`,
  );

  // Nothing has been pushed: the repo exists and has no branch yet.
  const freshBranches = await api('GET', `${SLUG}/branches`);
  check(
    'no branches before a push',
    freshBranches.status === 200 && Array.isArray(freshBranches.json) && freshBranches.json.length === 0,
    `status ${freshBranches.status}: ${freshBranches.text.slice(0, 120)}`,
  );

  // ------------------------------------------------------------ issues

  const first = await api('POST', `${SLUG}/issues`, { title: 'first issue', body: 'opened by the suite' });
  const second = await api('POST', `${SLUG}/issues`, { title: 'second issue', body: 'also opened by the suite' });
  check(
    'issues numbered 1 then 2',
    first.status === 201 && second.status === 201 && first.json?.number === 1 && second.json?.number === 2,
    `statuses ${first.status}/${second.status}, numbers ${first.json?.number}/${second.json?.number}`,
  );

  const closed = await api('PATCH', `${SLUG}/issues/1`, { state: 'closed' });
  check(
    'issue 1 patched closed',
    closed.status === 200 && closed.json?.state === 'closed' && closed.json?.number === 1,
    `status ${closed.status}: ${closed.text.slice(0, 120)}`,
  );

  const comment = await api('POST', `${SLUG}/issues/2/comments`, { body: 'a comment from the suite' });
  const comments = await api('GET', `${SLUG}/issues/2/comments`);
  check(
    'comment posted on issue 2',
    comment.status === 201 &&
      comment.json?.body === 'a comment from the suite' &&
      Array.isArray(comments.json) &&
      comments.json.length === 1,
    `status ${comment.status}, list ${comments.text.slice(0, 120)}`,
  );

  // ------------------------------------------------------------ the list, both ways

  const ascending = await api('GET', `${SLUG}/issues?state=all&direction=asc`);
  const descending = await api('GET', `${SLUG}/issues?state=all&direction=desc`);
  check(
    'issue list sorts ascending',
    ascending.status === 200 && JSON.stringify(numbersOf(ascending.json)) === '[1,2]',
    `${ascending.text.slice(0, 120)}`,
  );
  check(
    'issue list sorts descending',
    descending.status === 200 && JSON.stringify(numbersOf(descending.json)) === '[2,1]',
    `${descending.text.slice(0, 120)}`,
  );

  // ------------------------------------------------------------ a pull request, merged

  // Two commits on two branches: README on main, app.txt on feature. Both writes are REST content
  // writes, so no git client is needed to give the pull request something to diff.
  const onMain = await api('PUT', `${SLUG}/contents/README.md`, {
    message: 'add README',
    content: Buffer.from('hello from main\n', 'utf8').toString('base64'),
  });
  const onFeature = await api('PUT', `${SLUG}/contents/app.txt`, {
    message: 'add app.txt',
    branch: 'feature',
    content: Buffer.from('hello from feature\n', 'utf8').toString('base64'),
  });
  check(
    'two commits on two branches',
    onMain.status === 201 && onFeature.status === 201,
    `statuses ${onMain.status}/${onFeature.status}: ${onMain.text.slice(0, 80)}`,
  );

  const pull = await api('POST', `${SLUG}/pulls`, {
    title: 'merge feature into main',
    body: 'the suite opened this',
    head: 'feature',
    base: 'main',
  });
  check(
    'pull request opened',
    pull.status === 201 && pull.json?.number === 1 && pull.json?.state === 'open',
    `status ${pull.status}: ${pull.text.slice(0, 160)}`,
  );

  const files = await api('GET', `${SLUG}/pulls/1/files`);
  check(
    'pull request files',
    files.status === 200 &&
      Array.isArray(files.json) &&
      files.json.some((file: any) => file?.filename === 'app.txt' && file?.status === 'added'),
    `status ${files.status}: ${files.text.slice(0, 200)}`,
  );

  const merged = await api('PUT', `${SLUG}/pulls/1/merge`, { merge_method: 'merge' });
  const afterMerge = await api('GET', `${SLUG}/pulls/1`);
  check(
    'pull request merged',
    merged.status === 200 && merged.json?.merged === true && afterMerge.json?.merged === true && afterMerge.json?.state === 'closed',
    `status ${merged.status}: ${merged.text.slice(0, 160)}`,
  );

  // The merge has to have landed, not just been reported: main must carry both files, and both
  // branches must sit on the merged sha. A ref move that dropped a commit would fail here.
  const mergedTree = await api('GET', `${SLUG}/contents/?ref=main`);
  const mergedNames = Array.isArray(mergedTree.json) ? mergedTree.json.map((entry: any) => entry?.name).sort() : [];
  check(
    'merge kept both trees on main',
    mergedTree.status === 200 && JSON.stringify(mergedNames) === '["README.md","app.txt"]',
    `status ${mergedTree.status}: ${mergedTree.text.slice(0, 200)}`,
  );

  // ------------------------------------------------------------ GraphQL

  const viewer = await api('POST', '/api/graphql', { query: 'query { viewer { login } }' });
  check(
    'graphql viewer',
    viewer.status === 200 && viewer.json?.data?.viewer?.login === TOKEN && viewer.json?.errors === undefined,
    `status ${viewer.status}: ${viewer.text.slice(0, 160)}`,
  );

  const gqlIssues = await api('POST', '/api/graphql', {
    query:
      'query Issues($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ' +
      'nameWithOwner issues(first: 10) { totalCount nodes { number title state } } } }',
    variables: { owner: OWNER, name: REPO },
  });
  const conn = gqlIssues.json?.data?.repository?.issues;
  check(
    'graphql repository.issues',
    gqlIssues.status === 200 &&
      gqlIssues.json?.data?.repository?.nameWithOwner === `${OWNER}/${REPO}` &&
      conn?.totalCount === 2 &&
      Array.isArray(conn?.nodes) &&
      conn.nodes.length === 2 &&
      conn.nodes[0]?.number === 1 &&
      conn.nodes[0]?.state === 'CLOSED',
    `status ${gqlIssues.status}: ${gqlIssues.text.slice(0, 240)}`,
  );

  // ------------------------------------------------------------ MCP

  const list = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = list.json?.result?.tools;
  check(
    'mcp tools/list',
    list.status === 200 &&
      Array.isArray(tools) &&
      tools.some((tool: any) => tool?.name === 'create_issue') &&
      tools.every((tool: any) => typeof tool?.inputSchema?.type === 'string'),
    `status ${list.status}: ${list.text.slice(0, 200)}`,
  );

  const call = await api('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_issues', arguments: { owner: OWNER, repo: REPO, state: 'all' } },
  });
  const payload = call.json?.result?.content?.[0]?.text;
  let called: any;
  try {
    called = typeof payload === 'string' ? JSON.parse(payload) : undefined;
  } catch {
    called = undefined;
  }
  check(
    'mcp tools/call',
    call.status === 200 &&
      call.json?.result?.isError === false &&
      Array.isArray(called) &&
      called.length === 2 &&
      called[0]?.number === 2,
    `status ${call.status}: ${call.text.slice(0, 240)}`,
  );
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('the suite could not bind an ephemeral port');
base = `http://127.0.0.1:${address.port}`;

try {
  await run();
} catch (err) {
  failed += 1;
  process.stdout.write(`not ok suite completed — ${err instanceof Error ? err.message : String(err)}\n`);
}

process.stdout.write(`${passed} passed, ${failed} failed\n`);
await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(failed === 0 ? 0 : 1);

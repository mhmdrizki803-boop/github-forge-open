# github-core-clone-01 — OPEN FORGE

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mhmdrizki803-boop/github-forge-open/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mhmdrizki803-boop/github-forge-open/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process, standard library only: git smart HTTP
(upload-pack v2 with shallow fetch, receive-pack v0), the REST v3 API under `/api/v3`, the GraphQL v4
API at `/api/graphql`, and a Model Context Protocol endpoint at `/mcp`. Every object is written and
read by this repository's own code — no git binary, no proxy, no dependency, no build step.

    MAKEFUN_ENV_URL=http://store:8080 node main.ts

Local check, against the published suite:

    node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process

What it does, in one line each: `store.ts` keeps users, repositories, issues, pulls and git objects in
memory with a deterministic clock; `gitproto.ts` speaks pkt-lines, packs, shallow boundaries and the
receive-pack status report; `rest.ts` serves repositories, contents, branches, refs, issues, labels
and pull requests; `graphql.ts` parses and executes queries and mutations with introspection;
`mcp.ts` answers JSON-RPC initialize, tools/list and tools/call over the same store, so an agent's
write shows up in the REST view immediately.

Entered for [make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01), $500 in USDC.

MIT licensed (see LICENSE).

# github-core-clone-01 entry — OPEN FORGE

A standalone, GitHub-compatible git forge in one Node process, standard library only: git smart HTTP
(upload-pack v2, receive-pack v0), the REST v3 API under `/api/v3`, the GraphQL v4 API at
`/api/graphql`, and a Model Context Protocol endpoint at `/mcp`. Every object is written and read by
this repository's own code — no git binary, no proxy, no dependency.

    MAKEFUN_ENV_URL=http://store:8080 node main.ts

Local check, against the published suite:

    node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process

Bounty page: https://make.fun/bounty/github-core-clone-01

MIT licensed (see LICENSE).

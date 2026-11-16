# handle() performance notes
- Body reads now run only for `BODY_METHODS`; GET/HEAD/OPTIONS retain an empty buffer without Promise, await, or request listeners.
- Request targets are split manually at the first `?`, removing the per-request `URL` construction.
- Query-free requests reuse module-level `EMPTY_QUERY`; encoded path bytes remain unchanged.
- Existing body-read error handling and all downstream dispatch behavior are preserved.

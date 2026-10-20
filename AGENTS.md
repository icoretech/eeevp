# EEEVP

- EEEVP means encrypted end-to-end video player
- The product is a private authenticated video library with its canonical catalog on the server; every video list, metadata, and chunk request requires the library session
- Keep the separate master encryption key in browser memory only; authenticated devices unlock the same server catalog with that key
- Use Docker Compose for all JavaScript tooling: `docker compose exec -T web yarn ...`; do not silently run checks on the host
- Use Yarn 4 and install dependencies through Yarn commands
- Read the installed Next.js documentation under `node_modules/next/dist/docs` before changing framework behavior
- Do not use `any`, non-null assertions, or unvalidated mandatory environment defaults
- Keep application tests under `tests/`, separate from source files
- Use official shadcn CLI components; do not hand-edit `src/components/ui` or `src/lib/utils.ts`
- Keys and plaintext video metadata belong exclusively in the browser; never send decryption keys to the server, query strings, logs, or analytics
- Ciphertext and manifests persist under STORAGE_PATH on one durable filesystem shared by all server processes; never use process memory for durable state, and never deploy on an ephemeral filesystem
- Run `yarn biome:check`, `yarn typecheck`, and the relevant tests inside the web container after TypeScript changes
- Run production builds with `NODE_ENV=production`
- Keep technical documentation in `docs/` current and use generic sample values
- Do not create branches or Git worktrees without an explicit request
- Never run external coding-agent CLI reviews; use native subagents

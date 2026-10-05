# Deploy to the existing Hugging Face Space

Use `Parthg0106/syncscript-api`. Keep its SDK set to **Docker** and port `7860`.
The Static SDK serves browser assets; it cannot host the Node API, Socket.IO,
database connections, or terminal processes. Updating the existing Docker Space
does not create a new Space or purchase a subscription.

The image includes a shared, read-only language toolchain. Each workspace has
its own source and temporary directories and a distinct operating-system user.
Before starting commands, a privileged launcher clears inherited credentials
and descriptors, drops privileges, and applies Landlock filesystem rules and a
syscall filter. Commands can use the public toolchain and their own files, but
cannot read backend files or list other workspace directories. Path metadata
can remain visible; this boundary does not pretend to be a separate machine.
Startup requires working Landlock enforcement; there is no unrestricted shell
fallback.

The terminal remains real Bash with Python, Node/TypeScript, C/C++, Java, and
Git. On this host, terminal and CPU commands have **no network access**. Online
`npm install`, `pip install`, Git fetch/push, and network servers do not work
inside the sandbox; installed tools and uploaded dependencies work locally.
The API retains network access for Supabase, D1 and the separate GPU worker.
This is a filesystem/process sandbox with resource limits, not a separate VM.
Terminal-created files and dependencies live in the Space's temporary filesystem;
they are not automatically imported into the editor or D1. Keep durable source
changes in editor files. If an editor save displaces terminal changes, the shell
reports a recovery-copy path instead of silently discarding them.

## Existing settings

Keep `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGINS`,
and the mail settings. `NODE_ENV` should be `production`. `ENABLE_TERMINAL`
should be `true`. The image selects `RUNTIME_PROVIDER=local`; no new runtime
Space, runtime token, or account subscription is needed for this deployment.

## Additional Cloudflare settings

The D1 database `syncscript-content` and its tables have already been created.
Add these as **variables**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `acb988175d69b272c1facb3c6f2f4c08` |
| `CLOUDFLARE_D1_DATABASE_ID` | `2566c96b-196d-4049-ade8-a34709656263` |
| `FILE_CONTENT_STORAGE` | `postgres` for the first rollout; then `d1` |
| `D1_CHECK_ON_START` | Optional diagnostic; defaults to `false` |

Add **secret** `CLOUDFLARE_D1_API_TOKEN` using the Cloudflare API token from
`cloudflared1cred.txt`. Do not use the R2 access-key ID or secret-access key.
The ignored local `.env.d1-local` contains the verified values.

First deploy the new code with `FILE_CONTENT_STORAGE=postgres` and no backfill,
and verify the old API container has stopped. Older code cannot understand D1
references and must not remain a writer during conversion. Temporarily set
`D1_CHECK_ON_START=true` for this deployment to check D1 from the actual Space
network. This runs only `SELECT 1` and prints a sanitized result. In PostgreSQL
mode with backfill disabled, failure still allows API startup. Review the logs
and disable the diagnostic flag after confirming connectivity. Then set
`FILE_CONTENT_STORAGE=d1` and `D1_BACKFILL_ON_START=true` and restart the existing
Space. Startup requires a successful D1 check, uploads each blob before committing
its reference, verifies all references, and stops if any step fails. After a successful migration, remove
the backfill variable or set it to `false`.
Accounts, permissions, file metadata and other relational data stay in Supabase.
Keep Supabase's `DATABASE_URL`.

Storage can remain in Supabase during rollout by setting
`FILE_CONTENT_STORAGE=postgres`. Once rows reference D1, its credentials must
remain configured even in this mode. See [the D1 rollback procedure](cloudflare-d1-content.md)
before removing D1 configuration or deploying older code.

## GPU worker authentication

The GPU Stop button aborts the API's pending submission/output requests and marks
the session canceled; later output is discarded. Gradio's call endpoint does
not terminate an already queued/running ZeroGPU process. A canceled or uncertain
request keeps that worker reserved for three minutes before another request can
reclaim it. This cooldown avoids immediate overlap but cannot guarantee that an
externally queued job has finished. A normal completed request releases its
worker immediately. Account provisioning credentials are never forwarded.

The existing GPU worker remains separate. The backend no longer sends its
account-level `HF_TOKEN` into a container that runs user programs. Public worker
calls work without authentication, subject to Hugging Face's anonymous quota.
If authenticated quota is needed, set the optional **secret** `HF_GPU_TOKEN` to
a fine-grained token scoped only to reading/calling that GPU Space. Never reuse
the write token used for deployment/provisioning.

The shared ZeroGPU worker is not covered by the new local CPU/terminal sandbox.
Its multi-user execution boundary needs a separate review before using it for
confidential workloads.

## Database deployment

Startup verifies the existing schema before baselining old `db push`
installations and applies committed migrations. It never uses
`db push --accept-data-loss`. See [database deployment](database-deployment.md)
if preflight reports an incompatible schema. `DIRECT_URL` is optional when a
direct PostgreSQL connection is needed for migrations.

## Release verification and remaining dependency work

Reload existing editor tabs after the backend and frontend releases complete,
so every collaborator uses the updated editing protocol and recovery behavior.

The October 4, 2026 dependency audit reports six production-tree advisories:
four high findings in Prisma's CLI/config dependency tree and two moderate
findings in React Router. This app uses PostgreSQL rather than the affected
MySQL transport, static Prisma configuration, and client-side routes with
application-owned destinations. The full development audit also flags Vitest's
UI server; tests use `vitest run`, and the deployment does not start that server.
These findings remain dependency-upgrade work; passing the release checks is
not a claim of a clean dependency audit. The suggested major-version changes
need a separate compatibility check.

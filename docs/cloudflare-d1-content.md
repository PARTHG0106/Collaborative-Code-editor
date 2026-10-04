# Optional Cloudflare D1 content storage

Supabase/PostgreSQL remains responsible for users, authentication, workspace
membership, file metadata, chat and execution records. D1 can hold the text of
files and version snapshots. This is an opt-in storage split, not a guarantee of
lower latency: the Hugging Face API calls Cloudflare's REST API, adding network
round trips to saves and cold reads. Benchmark from the deployed region before
enabling it. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) for the
current free storage and usage allowances. R2 is a separate object-storage
product; its S3 access keys cannot be used as a D1 API token.

## Safety and behavior

- `FILE_CONTENT_STORAGE=postgres` is the default. Existing rows remain inline.
- An additive PostgreSQL migration adds nullable `content_key` columns. User
  text is never parsed as a pointer, so it can contain arbitrary strings.
- In D1 mode, new file and snapshot text is stored under an immutable SHA-256
  key and read back for integrity before PostgreSQL commits that key. A failed
  SQL commit may leave an unused blob, but a failed upload cannot publish an
  incomplete blob reference.
- UTF-16LE/base64 chunks preserve JavaScript text exactly. Each stored value is
  at most 256 KiB, below D1's 2 MB row/value limit; a manifest is published last.
  The adapter rejects text above 100 MiB without acknowledging a successful save.
  Encoding adds storage overhead, so D1 quota is not equivalent to raw text size.
- Reads validate chunk count, length and SHA-256. Missing data fails the request
  rather than silently replacing a file with an empty string. A small bounded
  process cache reduces reads; D1 availability is still required for cold reads
  and writes once enabled.
- The Prisma extension resolves content for the existing editor, snapshot,
  terminal and execution paths. It supports direct model operations, including
  bulk operations, and relation reads. Nested file-content writes are rejected;
  use `prisma.fileSystemItem` / `prisma.fileVersion` directly. Raw SQL and the
  unextended client are reserved for maintenance. Content filters, ordering and
  aggregates must not query the inline SQL placeholder after migration.
- Both stores are private and reached only through the authenticated server.
  Keep D1 credentials in server secrets, never frontend variables or source.
- Blob deletion is deliberately separate from metadata deletion: deduplicated
  blobs can be shared by multiple files/snapshots. This release retains unused
  blobs for recovery. Schedule a reviewed reachability-based cleanup before
  long-term use if retention or storage limits require it. Deleting a workspace
  removes access and its SQL references but does not erase D1 blob bytes.

## Enable

1. Create a D1 database in the same Cloudflare account. Supply a scoped API token
   with D1 read/write access to that account, the account ID, and database UUID
   as `CLOUDFLARE_D1_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
   `CLOUDFLARE_D1_DATABASE_ID`. Do not use the R2/S3 key pair.
2. Deploy the additive PostgreSQL migration with the updated server. Keep
   `FILE_CONTENT_STORAGE=postgres` until D1 is initialized and checked. All
   running API instances must use the new adapter before converting any rows;
   older releases interpret the SQL placeholder as an empty file.
3. Run `npm run d1:content --workspace=apps/server -- init --apply`. This only
   creates missing D1 tables; it does not create a database or migrate files.
4. Plan with `npm run d1:content --workspace=apps/server -- backfill`.
   Add `--apply` to copy existing file/snapshot text and replace matching SQL
   rows with references. The tool compares the original content/key/timestamp
   atomically, so concurrent edits are skipped instead of overwritten. It can
   be rerun; no inline copy is removed until its D1 upload succeeds.
5. Run `npm run d1:content --workspace=apps/server -- verify` to read and validate
   every referenced blob. Test create/edit/reconnect/snapshot/restore in an
   isolated workspace, then set `FILE_CONTENT_STORAGE=d1` on the API server.
   New saves now use D1. Rerun backfill/verify for any concurrent inline writes.

Commands use injected server environment variables first, then the ignored root
`.env.d1-local` (if present), then `.env`. The application itself loads only
`.env`; the D1-only file does not enable storage on a running server.
Maintenance uses `DIRECT_URL` when supplied, otherwise `DATABASE_URL`, and does
not require application JWT secrets. Its isolated database client disables
Prisma query and error logging so source text cannot appear in command output.
Backfill/restore/initialization are read-only plans
unless `--apply` is passed; verify always reads without writing. Command output
contains counts, never source text or credentials. Keep both SQL and D1 backups.

## Roll back

1. Switch every API instance to `FILE_CONTENT_STORAGE=postgres` while retaining
   all three D1 variables. Existing remote keys remain readable; new saves are
   inline and clear their old keys atomically.
2. Run `npm run d1:content --workspace=apps/server -- restore` to plan, then add
   `--apply` to restore D1 text into PostgreSQL. Concurrently modified rows are
   skipped and can be retried. Ensure PostgreSQL has enough free storage first.
3. Run `verify` again. Only after it reports **zero remote references** may you
   remove D1 configuration or deploy an older release. Do not drop D1 data or
   the additive SQL columns as part of routine rollback.

The content tables intentionally contain no user credentials. However, files
can contain private code or user-provided secrets, so apply the same access,
backup and retention policies as the original database.

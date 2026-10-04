# Database deployment

The server starts with `npm run db:deploy --workspace=apps/server`. This runs
`apps/server/scripts/deploy-migrations.cjs` before the application can accept
traffic. It uses `DIRECT_URL` when provided, otherwise `DATABASE_URL`; both must
target PostgreSQL's `public` schema. Prefer a direct connection or a session
pooler for Prisma migrations. No database URL or driver exception is printed.

The startup script inspects PostgreSQL's catalogs before changing migration
history. A database created by older `db push` deployments may have no Prisma
history. The script records only the six June migration entries, and only when
the completed June schema is present: required columns, types, nullability,
defaults, enum labels, primary and unique keys, and foreign-key behavior must
match. It recognizes both the original raw refresh-token column and the known
hashed-token replacement. The intermediate workspace-invitation schema is not
eligible for automatic baselining.

October migrations run normally through `prisma migrate deploy`. The execution
migration preserves compatible tables created by older deployments and creates
the missing tables, enums, and indexes on new installations. The script checks
the final execution schema, indexes, token hashes, and optional D1 reference
columns after Prisma succeeds. It does not move file contents into D1; that is
a separate, explicit content migration.

Deployment stops before baselining when it finds an incomplete or incompatible
schema, an unfinished migration, an unknown applied migration, or a changed
applied migration checksum. It does not automatically roll back failed
migrations, discard tables, reset databases, or mark new migrations applied.
Review the reported schema object or migration and repair it explicitly before
restarting. Existing migration checksums are compared with both LF and CRLF
encodings to allow the same committed SQL to be deployed from Linux and Windows.

The regression suite applies the actual migration SQL to isolated PostgreSQL
instances through PGlite. It covers fresh databases, legacy baselines, data
preservation, repeated deployments, and rejection of schema/history drift.
Production connectivity and schema are verified during startup using the
deployment's own database credentials.

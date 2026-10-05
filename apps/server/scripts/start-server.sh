#!/bin/sh
set -eu

npm run db:deploy --workspace=apps/server
if [ "${D1_CHECK_ON_START:-false}" = "true" ] || [ "${D1_BACKFILL_ON_START:-false}" = "true" ]; then
  if ! npm run d1:content --workspace=apps/server -- check; then
    if [ "${D1_BACKFILL_ON_START:-false}" = "true" ] || [ "${FILE_CONTENT_STORAGE:-postgres}" != "postgres" ]; then
      printf '%s\n' 'D1 startup connectivity check failed; refusing D1 startup or backfill.' >&2
      exit 1
    fi
    printf '%s\n' 'D1 startup connectivity check failed; continuing in PostgreSQL mode. No D1 backfill was attempted.' >&2
  fi
fi
if [ "${D1_BACKFILL_ON_START:-false}" = "true" ]; then
  npm run d1:content --workspace=apps/server -- backfill --apply
  npm run d1:content --workspace=apps/server -- verify
fi
exec node apps/server/dist/index.js

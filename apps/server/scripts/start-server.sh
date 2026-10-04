#!/bin/sh
set -eu

npm run db:deploy --workspace=apps/server
if [ "${D1_BACKFILL_ON_START:-false}" = "true" ]; then
  npm run d1:content --workspace=apps/server -- backfill --apply
  npm run d1:content --workspace=apps/server -- verify
fi
exec node apps/server/dist/index.js

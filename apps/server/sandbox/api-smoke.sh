#!/bin/sh
set -eu

# Integration gate for a built API image. Everything is disposable and uses
# fixed synthetic credentials on an internal Docker network; no host ports.
image=${1:-syncscript-api-check:latest}
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Git Bash otherwise rewrites Linux container paths such as /tests into host
# paths. Convert only the bind-mount source, then keep Docker arguments intact.
if command -v cygpath >/dev/null 2>&1; then
  directory=$(cygpath -am "$directory")
  export MSYS_NO_PATHCONV=1
fi
prefix="syncscript-smoke-$(date +%s)-$$"
network="$prefix-net"
database="$prefix-db"
server="$prefix-api"
client="$prefix-client"
network_created=false
database_created=false
server_created=false
client_created=false
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$result" -ne 0 ] && [ "$server_created" = true ]; then docker logs --tail 150 "$server" || true; fi
  if [ "$client_created" = true ]; then docker rm -f "$client" >/dev/null 2>&1 || true; fi
  if [ "$server_created" = true ]; then docker rm -f "$server" >/dev/null 2>&1 || true; fi
  if [ "$database_created" = true ]; then docker rm -f "$database" >/dev/null 2>&1 || true; fi
  if [ "$network_created" = true ]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  exit "$result"
}
trap cleanup EXIT INT TERM

docker image inspect "$image" >/dev/null
docker network create --internal "$network" >/dev/null
network_created=true
docker create --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=smoke -e POSTGRES_PASSWORD=smoke-db-password -e POSTGRES_DB=smoke \
  postgres:16 >/dev/null
database_created=true
docker start "$database" >/dev/null
attempt=0
until docker exec "$database" pg_isready -U smoke -d smoke >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; fi
  sleep 1
done
docker create --name "$server" --network "$network" --network-alias api \
  -e NODE_ENV=production \
  -e 'DATABASE_URL=postgresql://smoke:smoke-db-password@db:5432/smoke?schema=public' \
  -e JWT_ACCESS_SECRET=smoke-access-secret-0123456789abcdef0123456789 \
  -e JWT_REFRESH_SECRET=smoke-refresh-secret-0123456789abcdef0123456789 \
  -e JWT_ACCESS_EXPIRY=1h -e CORS_ORIGINS=http://smoke.invalid \
  -e FILE_CONTENT_STORAGE=postgres -e RUNTIME_PROVIDER=local -e ENABLE_TERMINAL=true "$image" >/dev/null
server_created=true
docker start "$server" >/dev/null
docker create --name "$client" --network "$network" \
  -v "$directory:/tests:ro" -e SMOKE_DISPOSABLE=1 -e SMOKE_API_ORIGIN=http://api:7860 \
  -e 'SMOKE_DATABASE_URL=postgresql://smoke:smoke-db-password@db:5432/smoke' \
  "$image" node /tests/api-smoke.cjs >/dev/null
client_created=true
docker start --attach "$client"
result=$(docker inspect --format '{{.State.ExitCode}}' "$client" | tr -d '\r')
test "$result" -eq 0

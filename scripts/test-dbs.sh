#!/usr/bin/env bash
# Starts throwaway Postgres (55432) and MySQL (53306) containers with sample data for testing.
set -euo pipefail
docker rm -f querybird-test-pg querybird-test-my >/dev/null 2>&1 || true
docker run -d --name querybird-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=shop -p 55432:5432 postgres:16 >/dev/null
docker run -d --name querybird-test-my -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=shop -p 53306:3306 mysql:8.4 >/dev/null
echo "waiting for databases..."
until docker exec querybird-test-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
until docker exec querybird-test-my mysql -uroot -e "select 1" >/dev/null 2>&1; do sleep 2; done
dir="$(cd "$(dirname "$0")" && pwd)"
docker exec -i querybird-test-pg psql -q -U postgres -d shop < "$dir/seed-postgres.sql"
docker exec -i querybird-test-my mysql -uroot shop < "$dir/seed-mysql.sql"
echo "ready: postgresql://postgres@127.0.0.1:55432/shop  mysql://root@127.0.0.1:53306/shop"

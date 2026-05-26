#!/bin/bash
set -e

if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  echo "Waiting for postgres-primary to be ready..."
  until pg_isready -h postgres-primary -p 5432 -U postgres; do
    sleep 1
  done

  echo "Running pg_basebackup from postgres-primary..."
  PGPASSWORD=replicapass pg_basebackup \
    -h postgres-primary \
    -p 5432 \
    -U replicator \
    -D "$PGDATA" \
    -Fp -Xs -R -P \
    --checkpoint=fast

  echo "Replica data directory initialized."
fi

exec docker-entrypoint.sh postgres "$@"

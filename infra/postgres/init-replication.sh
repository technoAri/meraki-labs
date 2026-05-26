#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replicapass';
EOSQL

echo "host replication replicator all md5" >> "$PGDATA/pg_hba.conf"
pg_ctl reload -D "$PGDATA"

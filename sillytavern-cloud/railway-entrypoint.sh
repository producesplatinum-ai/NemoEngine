#!/bin/sh
set -eu

mkdir -p \
  /persistent/config \
  /persistent/data/default-user \
  /persistent/plugins \
  /persistent/extensions \
  /persistent/backups

node /usr/local/bin/seed-provider-secrets.mjs

exec /home/node/app/docker-entrypoint.sh "$@"

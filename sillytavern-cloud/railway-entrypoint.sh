#!/bin/sh
set -eu

mkdir -p \
  /persistent/config \
  /persistent/data/default-user \
  /persistent/plugins \
  /persistent/extensions \
  /persistent/backups

node /usr/local/bin/seed-provider-secrets.mjs
node /usr/local/bin/seed-connection-profiles.mjs
node /usr/local/bin/seed-nemoengine.mjs
node /usr/local/bin/optimize-nemo-runtime.mjs
node /usr/local/bin/install-nemo-full-bootstrap.mjs

exec /home/node/app/docker-entrypoint.sh "$@"

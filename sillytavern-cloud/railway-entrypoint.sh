#!/bin/sh
set -eu

mkdir -p \
  /persistent/config \
  /persistent/data/default-user \
  /persistent/plugins \
  /persistent/extensions \
  /persistent/backups

cp /usr/local/share/darya-source-import.mjs /persistent/plugins/darya-source-import.mjs
node /usr/local/bin/seed-provider-secrets.mjs
node /usr/local/bin/seed-connection-profiles.mjs
node /usr/local/bin/import-darya-url-jobs.mjs
node /usr/local/bin/seed-darya.mjs || echo "Darya seed deferred; continuing SillyTavern startup" >&2
node /usr/local/bin/seed-nemoengine.mjs
node /usr/local/bin/optimize-nemo-runtime.mjs
node /usr/local/bin/install-nemo-full-bootstrap.mjs

exec /home/node/app/docker-entrypoint.sh "$@"

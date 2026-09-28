#!/bin/sh
set -eu

mkdir -p \
  /persistent/config \
  /persistent/data \
  /persistent/plugins \
  /persistent/extensions \
  /persistent/backups

exec /home/node/app/docker-entrypoint.sh "$@"

FROM ghcr.io/sillytavern/sillytavern:latest

USER root
WORKDIR /home/node/app

COPY railway-entrypoint.sh /usr/local/bin/railway-sillytavern-entrypoint
COPY seed-provider-secrets.mjs /usr/local/bin/seed-provider-secrets.mjs
COPY test-seed-provider-secrets.mjs /tmp/test-seed-provider-secrets.mjs
COPY test-seed-connection-profiles.mjs /tmp/test-seed-connection-profiles.mjs
RUN node --test /tmp/test-seed-provider-secrets.mjs /tmp/test-seed-connection-profiles.mjs \
    && rm -f /tmp/test-seed-provider-secrets.mjs /tmp/test-seed-connection-profiles.mjs
RUN chmod +x /usr/local/bin/railway-sillytavern-entrypoint \
    && rm -rf config data plugins backups public/scripts/extensions/third-party \
    && ln -s /persistent/config config \
    && ln -s /persistent/data data \
    && ln -s /persistent/plugins plugins \
    && ln -s /persistent/backups backups \
    && ln -s /persistent/extensions public/scripts/extensions/third-party

ENTRYPOINT ["tini", "--", "/usr/local/bin/railway-sillytavern-entrypoint"]

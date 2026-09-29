FROM ghcr.io/sillytavern/sillytavern:latest

USER root
WORKDIR /home/node/app

COPY railway-entrypoint.sh /usr/local/bin/railway-sillytavern-entrypoint
COPY seed-provider-secrets.mjs /usr/local/bin/seed-provider-secrets.mjs
COPY seed-connection-profiles.mjs /usr/local/bin/seed-connection-profiles.mjs
COPY seed-nemoengine.mjs /usr/local/bin/seed-nemoengine.mjs
COPY optimize-nemo-runtime.mjs /usr/local/bin/optimize-nemo-runtime.mjs
COPY install-nemo-full-bootstrap.mjs /usr/local/bin/install-nemo-full-bootstrap.mjs
COPY nemo-full-bootstrap /usr/local/share/nemo-full-bootstrap
COPY test-seed-provider-secrets.mjs /tmp/test-seed-provider-secrets.mjs
COPY test-seed-connection-profiles.mjs /tmp/test-seed-connection-profiles.mjs
COPY test-seed-nemoengine.mjs /tmp/test-seed-nemoengine.mjs
COPY test-install-nemo-full-bootstrap.mjs /tmp/test-install-nemo-full-bootstrap.mjs
COPY test-optimize-nemo-runtime.mjs /tmp/test-optimize-nemo-runtime.mjs
RUN node --test /tmp/test-seed-provider-secrets.mjs /tmp/test-seed-connection-profiles.mjs /tmp/test-seed-nemoengine.mjs /tmp/test-install-nemo-full-bootstrap.mjs /tmp/test-optimize-nemo-runtime.mjs \
    && rm -f /tmp/test-seed-provider-secrets.mjs /tmp/test-seed-connection-profiles.mjs /tmp/test-seed-nemoengine.mjs /tmp/test-install-nemo-full-bootstrap.mjs /tmp/test-optimize-nemo-runtime.mjs
RUN chmod +x /usr/local/bin/railway-sillytavern-entrypoint \
    && rm -rf config data plugins backups public/scripts/extensions/third-party \
    && ln -s /persistent/config config \
    && ln -s /persistent/data data \
    && ln -s /persistent/plugins plugins \
    && ln -s /persistent/backups backups \
    && ln -s /persistent/extensions public/scripts/extensions/third-party

ENTRYPOINT ["tini", "--", "/usr/local/bin/railway-sillytavern-entrypoint"]

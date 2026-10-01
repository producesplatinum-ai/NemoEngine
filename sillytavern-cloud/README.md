# SillyTavern on Railway

This wrapper keeps the upstream SillyTavern container unchanged except for persistence layout.

Railway allows one volume per service, while the official SillyTavern Docker setup uses separate persistent directories for config, data, server plugins, and third-party UI extensions. The service mounts one Railway volume at /persistent and this image maps:

- /persistent/config -> /home/node/app/config
- /persistent/data -> /home/node/app/data
- /persistent/plugins -> /home/node/app/plugins
- /persistent/extensions -> /home/node/app/public/scripts/extensions/third-party
- /persistent/backups -> /home/node/app/backups

The base image remains ghcr.io/sillytavern/sillytavern:latest.

# Oracle Cloud Always Free: SillyTavern + NemoEngine MCP

This package installs **deployment files in GitHub**, not an Oracle VM. Nothing is deployed until an eligible Oracle account creates a VM and installs Docker on it. Oracle Always Free availability depends on region, resource quota and account verification; selecting additional paid resources may incur charges.

## Prerequisites

- An Oracle Always Free ARM64 Linux VM, preferably Ubuntu 24.04. Verify the VM's shape and disks qualify for Always Free before proceeding.
- Docker Engine and Docker Compose v2 on that VM, plus Git and optionally Tailscale.
- Private network access from iPhone. By default both HTTP ports are bound to host **127.0.0.1** only. Do not add public ingress rules for 8000 or 8790.
- A **separate backup** of existing SillyTavern data. The prior Railway data volume is NOT accessible to this GitHub package, so an empty deployment does not restore your old Darya avatar, Lorebook or chats.

## Start on the VM

```bash
git clone --branch feat/oracle-always-free-deployment-20261012 https://github.com/producesplatinum-ai/NemoEngine.git
cd NemoEngine
cp deploy/oracle/.env.example deploy/oracle/.env
# If SillyTavern already uses HTTP Basic Auth, edit the credentials in .env locally.
mkdir -p deploy/oracle/state/{config,data,plugins,extensions,backups}
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yaml config --quiet
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yaml up -d --build
```

Verify on the VM:

```bash
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yaml ps
curl -fsS http://127.0.0.1:8790/healthz
```

There are only two containers: official SillyTavern and the repository's Node.js `mcp/sillytavern-server.mjs` gateway. The gateway supports NemoEngine portable instruction compilation; it is not automatically connected to ChatGPT or private Diary SexSkills. It does not launch every independent service formerly present in Railway.

## iPhone access through Tailscale

Install Tailscale on the Oracle VM and on iPhone, sign into the same tailnet, and use Tailscale Serve to share the two **localhost** ports with your own tailnet over private HTTPS. Follow the syntax for your installed Tailscale version at https://tailscale.com/kb/1312/serve. Limit access with tailnet ACLs/grants and configure authentication in SillyTavern. Never publicly forward the 8000/8790 ports or expose the unsecured MCP endpoint on the open internet.

## Persistence and backups

- Host bind mounts under `deploy/oracle/state/` contain configuration, user data (including characters, Lorebooks and chats), plugins, extensions and backup files.
- **Не сохраняй секреты**, API-ключи, личный дневник, фотографии, карточки и чаты в публичном GitHub-репозитории. Особенно не отправляй `deploy/oracle/.env` и `deploy/oracle/state/` в Git.
- Keep **encrypted, external, tested backups** outside the VM. Snapshot or image availability is not a substitute for a usable backup.
- The old Railway persistent storage must be exported separately if it becomes accessible again. No prior user data or provider credentials have been copied or reconstructed here.
- Treat the default upstream SillyTavern image version as a moving dependency. For production, pin a tested image digest.

## Not drop-in compatible

Cloudflare STWorkers is a separate serverless port of SillyTavern, not a host for this Node.js gateway. Hugging Face Docker Spaces can run Docker workloads only if the account can create compute Spaces and has a separate persistent-storage solution. Those alternatives are not installed by this Oracle-specific package.

## Validation

```bash
node --test deploy/oracle/test-layout.mjs
docker compose --env-file deploy/oracle/.env.example -f deploy/oracle/compose.yaml config --quiet
```

These are configuration-level checks only. Deployment to a real Oracle account, restoration of Darya data, iPhone Tailscale access and proof of a model generation each need separate live verification.

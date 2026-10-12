# SillyTavern + NemoEngine on Oracle Cloud Always Free (or a Linux host)

**State:** ready-to-review configuration, NOT installed on an Oracle account. GitHub can build and check the deployment package but cannot create a VM without access to an Oracle account. There is no silent migration of Railway's persistent volume.

The `compose.yaml` uses the official SillyTavern Docker image and builds two Node.js 22 services from this same NemoEngine Git branch: the SillyTavern MCP gateway and the NemoEngine MCP executor. This branch inherits the module-audit improvements of PR #18.

## What is preserved

The following SillyTavern directories are bind-mounted under `deploy/oci-always-free/state/sillytavern/`: `config`, `data`, `plugins`, `extensions`, and `backups`. Data is independent of replacing the container. The NemoEngine run folder is also mounted. **Files from Railway do not automatically appear in these folders.**

Ports 8000 (SillyTavern), 8790 (gateway), and 8787 (Nemo MCP) all bind to `127.0.0.1` on the VM; no public port is exposed by the Compose file.

## 1 — Provision host

Create an Oracle Cloud Always Free ARM VM (Ubuntu, Ampere A1) only if the VM and storage are listed within your account's no-charge quota. Confirm region availability and any billing requirements in the OCI console; account and resource limits vary. Docker Compose also works on another Linux server or on a Mac.

Install Docker Engine, Docker Compose plugin, and Git using official vendor guides. Keep incoming public TCP ports 8000, 8787 and 8790 **closed** in the Oracle security list and system firewall.

## 2 — Install the project

```sh
git clone --branch feat/oci-always-free-deployment-20261012 https://github.com/producesplatinum-ai/NemoEngine.git
cd NemoEngine
cp deploy/oci-always-free/.env.example deploy/oci-always-free/.env
chmod 600 deploy/oci-always-free/.env
docker compose -f deploy/oci-always-free/compose.yaml config --quiet
docker compose -f deploy/oci-always-free/compose.yaml up -d --build
docker compose -f deploy/oci-always-free/compose.yaml ps
curl -fsS http://127.0.0.1:8790/healthz
curl -fsS http://127.0.0.1:8787/healthz
```

The official SillyTavern image initializes a fresh configuration on first start. Gateway variables `SILLYTAVERN_BASIC_AUTH_USERNAME` and `SILLYTAVERN_BASIC_AUTH_PASSWORD` are only for connecting **to** an already configured SillyTavern and do **not** enable SillyTavern authentication by themselves. Do not expose these servers on public interfaces. For remote iPhone use, install Tailscale on the VM and iPhone, use a private tailnet, and configure Tailscale Serve (for example, `tailscale serve --bg 8000`; confirm syntax for your installed version).

**ChatGPT Cloud cannot directly reach private Tailscale-only MCP ports.** Integrating a cloud connector needs a separate authenticated HTTPS bridge, which is intentionally not deployed here.

## 3 — Recover existing Darья character and chats

Before migration, **do not delete** the expired Railway project or its persistent storage volume. Retrieve a legitimate backup/export when available; if account restrictions block volume access, cloning GitHub code alone cannot recover that private data.

After backing up the new container's empty state, stop SillyTavern, restore the Railway `config`, `data`, `plugins`, `extensions` and `backups` folders into the corresponding `state/sillytavern` paths, then restart. Verify Darya's original card, `Darya` World Info and chat IDs. No private diary, API token or photos should be committed to GitHub. The `state/` and `.env` paths are Git-ignored.

## 4 — Proof-based testing

After authenticating to your gateway, perform **one** test generation with the prepared NemoEngine profile and read back the saved chat. Compare the same run's nonce, `extra.nemo_compiled_sha256`, `extra.nemo_module_evidence.instructionsSha256`, emitted module IDs, and omission reasons.

This proves which instructions were actually compiled and passed in the request, not that the LLM semantically obeyed each module. External Diary SexSkills are not injected by this package; they remain `externalSexSkills: not-attached` until a separate, privacy-reviewed integration is built.

## Operations and limitations

```sh
docker compose -f deploy/oci-always-free/compose.yaml logs --tail=80 sillytavern sillytavern-mcp nemoengine-mcp
docker compose -f deploy/oci-always-free/compose.yaml ps
docker compose -f deploy/oci-always-free/compose.yaml down
```

Use private, encrypted backups of the `state/` directory; persistent host folders are **not** automatic backups. Do not use `down -v` to solve problems or destroy your source data.

The current Cloudflare STWorkers project is a separate incomplete serverless rewrite and cannot run these unchanged Node services. Hugging Face's official GitHub docs currently say **creating a new Docker Space requires a paid plan** despite no CPU Basic hourly charge; default storage is ephemeral. These are not drop-in free replacements for the full existing system.

## Release conditions

- GitHub CI must pass the Docker Compose security/persistence tests.
- Oracle VM creation and provision must be verified against the actual account's free quotas.
- All three containers must be healthy and private.
- Data restore must be verified against the source backup.
- The module evidence from a real generation must match the independently read-back saved chat.

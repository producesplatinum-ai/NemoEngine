# Oracle Cloud Always Free deployment (SillyTavern + NemoEngine)

This is an **installation blueprint**, not a deployed Oracle instance. It keeps the upstream SillyTavern image and the NemoEngine Node 22 servers separate. It uses local-only host ports and named persistent Docker volumes.

## Prerequisites

- An approved Oracle Cloud Infrastructure account with eligible Always Free resources available in your chosen region.
- One Ubuntu Linux VM (Ampere ARM64 is suitable for the official multi-arch SillyTavern image), Docker Engine and Docker Compose plugin installed.
- SSH access for initial setup, then preferably Tailscale for **private** access from iPhone or Mac.
- A trustworthy backup of existing SillyTavern data. GitHub repository files alone are **not** a substitute for your old Railway volumes.

Check Oracle's actual billing meters and quotas yourself; never select paid VM shapes or block volumes by accident. Always Free does not mean an infinite entitlement or guaranteed regional capacity.

## Install on the VM

```sh
git clone --branch feat/free-oracle-deployment-20261012 \
  https://github.com/producesplatinum-ai/NemoEngine.git
cd NemoEngine
cp deploy/oci/env.example deploy/oci/.env
docker compose --env-file deploy/oci/.env -f deploy/oci/compose.yaml config --quiet
docker compose --env-file deploy/oci/.env -f deploy/oci/compose.yaml up -d --build
docker compose --env-file deploy/oci/.env -f deploy/oci/compose.yaml ps
```

If SillyTavern's HTTP Basic Auth is enabled, put the same username and password into the private `deploy/oci/.env` file; **never** commit passwords or API tokens. Configure any API provider keys in your private instance, not this repository.

The official SillyTavern container is exposed *only* to the VM's loopback on port 8000; the SillyTavern MCP gateway uses loopback port 8790, and the standalone NemoEngine MCP server uses loopback port 8787. They communicate over an internal Docker network. A remote iPhone cannot reach loopback directly: use Tailscale Serve/private-network access or authenticated SSH tunnelling. Do **not** open 8000, 8790 or 8787 to the public internet without an independently verified authentication and TLS setup.

### Health checks

```sh
docker compose -f deploy/oci/compose.yaml ps
curl -fsS http://127.0.0.1:8790/healthz
```

Once running, log into SillyTavern over your private tunnel and complete first-run configuration. The native SillyTavern image may require configuration for external access through your private tunnel; validate this before enabling external access.

### Persistent data and updates

Named volumes persist across `docker compose down` and restarts. They store:

- `st_config` — configuration
- `st_data` — users, cards, world info and conversations
- `st_plugins`, `st_extensions` — server and UI plugins
- `st_backups` — local backups

**Never use `docker compose down --volumes` unless you have verified external backups.** Set up encrypted off-host backups before importing the user's private diary, Darya assets, chats, passwords or provider credentials.

The retired Railway services are separate resources. This deployment **does not** extract, copy, or restore Railway volumes automatically. First export original data through the legitimate backup/export route; never attempt to reconstruct private chats from public NemoEngine code.

### Compatibility gaps

- The ChatGPT-connected SillyTavern Mobile iOS Free plugin currently uses **Railway redeploy / `SILLYTAVERN_ONE_SHOT_JSON`**, and will not control this OCI installation without a **separately tested transport migration**. Native SillyTavern and NemoEngine run independently of that plugin.
- Darya's custom `darya-mcp` is not installed by this stack. Its separate source/configuration has not been confirmed in this branch.
- GitHub Diary SexSkills are **not** automatically injected into DeepSeek merely by hosting the containers. The audited NemoEngine PR #18 is separate and must be merged/tested explicitly.
- All three processes use CPU only for orchestration; external models remain separately billed under your DeepSeek / other provider account terms.
- The exact hosting rollout is **not E2E validated** until an OCI account, VM, backup restoration and private network are available.

## Other "free" alternatives considered

Cloudflare STWorkers (https://github.com/begonia599/STWorkers) can deploy a reimplemented SillyTavern-like frontend using Workers/D1/R2 within quotas, but it **does not** run these existing Node processes unchanged and needs a separate account and R2 setup. It is not silently installed here.

Hugging Face Spaces (https://github.com/huggingface/hub-docs/blob/main/docs/hub/spaces-overview.md) documents that new Docker Spaces require a paid plan, even though CPU Basic has zero hourly compute charge; thus it is **not** the no-paid-plan replacement sought here.

Oracle Always Free is therefore the concrete target for this opt-in installation blueprint.

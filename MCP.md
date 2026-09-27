# NemoEngine MCP bridge

This directory exposes the existing NemoEngine 11.5.2 ChatGPT executor as a
Streamable HTTP MCP server. It is intentionally a thin transport layer: the
authoritative preset, compiler, executor lifecycle, validation, and sanitizer
remain unchanged.

## Source of truth

The bridge delegates to:

- `Nemo Engine/Nemo Engine 11.5.2 - General RP.json`
- `scripts/nemo-chatgpt-runtime.mjs`
- `scripts/nemo-chatgpt-executor.mjs`

It does not reimplement prompt selection, compilation, delivery receipts, or
output sanitization.

## Requirements

- Node.js 22 or newer
- npm

Install dependencies:

```sh
npm install
```

Run the existing NemoEngine tests and the MCP bridge unit tests:

```sh
npm test
```

Start the MCP server:

```sh
PORT=8787 npm start
```

The default endpoints are:

- MCP: `http://localhost:8787/mcp`
- health: `http://localhost:8787/healthz`

For a personal development deployment, `NEMO_MCP_ENDPOINT_PATH` can move the
MCP endpoint to a hard-to-guess path that still ends in `/mcp`, for example:

```sh
NEMO_MCP_ENDPOINT_PATH=/dev-4d5f2f2a/mcp npm start
```

This is only an accidental-discovery reduction, not authentication. URLs can
appear in logs. Use OAuth 2.1 before treating an Internet-reachable deployment
as a production or multi-user service.

## MCP tools

The server exposes the executor lifecycle directly:

1. `nemo_prepare`
   - creates a private managed temporary parent
   - writes a v2 run spec from the exact task
   - invokes executor `prepare`
   - returns a UUID `runId` and the public receipt
2. `nemo_status`
   - invokes executor `status`
3. `nemo_next`
   - returns the complete pending delivery frame
4. `nemo_advance`
   - acknowledges a completely seen footer with its exact unit, SHA-256, and
     receipt
   - returns the next frame or `ready_to_draft`
5. `nemo_finish`
   - writes the draft outside the executor-owned run directory
   - invokes `finish`
   - returns only `show-output`
   - deletes the external draft after verified output is obtained
6. `nemo_discard_run`
   - removes a managed temporary run after completion or when a stale task must
     be abandoned

The bridge never accepts a filesystem path from the MCP caller. Run directories
are addressed only by UUIDv4 `runId` values and remain under the configured
managed root.

## Exact task and selection semantics

`nemo_prepare.request` must be the exact current user request. Optional
continuity must contain only facts visible to the active conversation.

The tool preserves the executor's distinction between omitted and explicitly
empty families. For example, omitting `nsfw` preserves the normalized profile
default, while `nsfw: []` explicitly clears that family. The same rule applies
to `fetish`.

The bridge does not silently fill `allowNonPortable`, bind unknown dynamic
macros, or choose mutually exclusive modules. Those decisions remain explicit
and fail closed in the executor.

## Test with MCP Inspector

With the server running locally:

```sh
npx @modelcontextprotocol/inspector@latest
```

Choose **Streamable HTTP** and connect to:

```text
http://localhost:8787/mcp
```

A safe first test is an inspect-mode call:

```json
{
  "mode": "inspect",
  "request": "Inspect this NemoEngine configuration",
  "profile": 100001,
  "selections": {
    "groups": [
      {
        "group": "Narrate-Language",
        "selector": "Narrate: Russian"
      }
    ]
  }
}
```

## Railway

Railway can deploy the repository directly after this branch is merged.

Recommended service settings:

- runtime: Node.js
- start command: `npm start`
- healthcheck path: `/healthz`
- public networking: enabled only for a development connection or after OAuth
  is configured
- `PORT`: use Railway's injected value
- optional `NEMO_MCP_ENDPOINT_PATH`: a private development path ending in
  `/mcp`

After Railway assigns a domain, the ChatGPT MCP URL is:

```text
https://<railway-domain><NEMO_MCP_ENDPOINT_PATH>
```

If the endpoint uses the default path:

```text
https://<railway-domain>/mcp
```

For ChatGPT developer-mode testing, use the no-auth connection only while the
server is deliberately treated as a personal development endpoint. For a
persistent Internet-facing connection, implement the MCP OAuth 2.1 resource
server flow and token verification rather than adding a custom API-key header:
ChatGPT MCP connections do not use arbitrary user-supplied API keys as the
standard authentication mechanism.

## Compatibility boundary

A working MCP connection does not turn NemoEngine source labels into ChatGPT
system messages and does not create exact SillyTavern parity. The existing
`CHATGPT_CONNECTOR.md` and `references/chatgpt-runtime.md` compatibility
boundary remains authoritative.

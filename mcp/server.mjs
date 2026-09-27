import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const THIS_FILE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(THIS_FILE), '..');
const EXECUTOR = join(REPO_ROOT, 'scripts', 'nemo-chatgpt-executor.mjs');
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_PORT = 8787;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

export const RUNS_ROOT = resolve(
  process.env.NEMO_MCP_RUN_ROOT || join(tmpdir(), 'nemoengine-mcp-runs'),
);

const groupSelectionSchema = z.object({
  group: z.string().min(1).max(200),
  selector: z.string().min(1).max(500),
});

const selectionsSchema = z.object({
  vex: z.string().min(1).max(500).optional(),
  nsfw: z.array(z.string().min(1).max(500)).max(64).optional(),
  fetish: z.array(z.string().min(1).max(500)).max(64).optional(),
  groups: z.array(groupSelectionSchema).max(64).optional(),
  enable: z.array(z.string().min(1).max(500)).max(512).optional(),
  disable: z.array(z.string().min(1).max(500)).max(512).optional(),
}).optional();

const stringMapSchema = z.record(z.string().min(1).max(500), z.string().max(100_000));

const contextSchema = z.object({
  macros: stringMapSchema.optional(),
  globals: stringMapSchema.optional(),
  variables: stringMapSchema.optional(),
}).optional();

const prepareSchema = z.object({
  mode: z.enum(['generate', 'inspect']).default('generate'),
  request: z.string().min(1).max(200_000),
  continuity: z.string().max(50_000).optional(),
  deliveryUnitChars: z.number().int().min(2_000).max(12_000).default(8_000),
  profile: z.number().int().positive().default(100001),
  maxPortableChars: z.number().int().min(1).max(170_000).default(170_000),
  selections: selectionsSchema,
  context: contextSchema,
  allowNonPortable: z.array(z.string().min(1).max(500)).max(128).default([]),
});

const runIdSchema = z.object({
  runId: z.string().regex(RUN_ID_RE),
});

const advanceSchema = z.object({
  runId: z.string().regex(RUN_ID_RE),
  unit: z.number().int().positive(),
  sha256: z.string().regex(SHA256_RE),
  receipt: z.string().min(1).max(2_000),
});

const finishSchema = z.object({
  runId: z.string().regex(RUN_ID_RE),
  draft: z.string().min(1).max(500_000),
});

function textResult(text, extra = {}) {
  return {
    content: [{ type: 'text', text }],
    ...extra,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(`NemoEngine MCP error: ${message}`, { isError: true });
}

export function buildRunSpec(input) {
  const selections = {
    groups: input.selections?.groups ?? [],
    enable: input.selections?.enable ?? [],
    disable: input.selections?.disable ?? [],
  };

  if (input.selections?.vex !== undefined) selections.vex = input.selections.vex;
  if (input.selections?.nsfw !== undefined) selections.nsfw = input.selections.nsfw;
  if (input.selections?.fetish !== undefined) selections.fetish = input.selections.fetish;

  const task = {
    mode: input.mode,
    request: input.request,
  };

  if (input.continuity !== undefined && input.continuity !== '') {
    task.continuity = input.continuity;
  }

  const spec = {
    schemaVersion: 'nemo-chatgpt-run-spec/v2',
    task,
    deliveryUnitChars: input.deliveryUnitChars,
    profile: input.profile,
    maxPortableChars: input.maxPortableChars,
    selections,
    allowNonPortable: input.allowNonPortable ?? [],
  };

  if (input.context !== undefined) {
    spec.context = {
      macros: input.context.macros ?? {},
      globals: input.context.globals ?? {},
      variables: input.context.variables ?? {},
    };
  }

  return spec;
}

export function resolveRunPaths(runId) {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('Invalid runId.');
  }

  const parent = resolve(RUNS_ROOT, runId);
  const expectedPrefix = `${RUNS_ROOT}/`;
  if (!parent.startsWith(expectedPrefix)) {
    throw new Error('runId escaped the managed run root.');
  }

  return {
    parent,
    spec: join(parent, 'run-spec.json'),
    run: join(parent, 'run'),
    draft: join(parent, 'draft.txt'),
  };
}

function normalizeEndpointPath(value = '/mcp') {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('NEMO_MCP_ENDPOINT_PATH must be an absolute URL path.');
  }

  const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  if (!normalized.endsWith('/mcp') && normalized !== '/mcp') {
    throw new Error('NEMO_MCP_ENDPOINT_PATH must end with /mcp.');
  }

  return normalized;
}

export const MCP_ENDPOINT_PATH = normalizeEndpointPath(
  process.env.NEMO_MCP_ENDPOINT_PATH || '/mcp',
);

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function runExecutor(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [EXECUTOR, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = null;

    const append = (chunks, chunk, currentBytes, limit, label) => {
      const nextBytes = currentBytes + chunk.length;
      if (nextBytes > limit && overflow === null) {
        overflow = `${label} exceeded the MCP bridge limit of ${limit} bytes.`;
        child.kill('SIGKILL');
      } else if (overflow === null) {
        chunks.push(chunk);
      }
      return nextBytes;
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes, MAX_STDOUT_BYTES, 'stdout');
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes = append(stderr, chunk, stderrBytes, MAX_STDERR_BYTES, 'stderr');
    });

    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (overflow !== null) {
        rejectPromise(new Error(overflow));
        return;
      }

      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();

      if (code !== 0) {
        const suffix = err || out.trim() || `exit code ${code}; signal ${signal ?? 'none'}`;
        rejectPromise(new Error(suffix));
        return;
      }

      resolvePromise(out);
    });
  });
}

async function prepareRun(input) {
  await mkdir(RUNS_ROOT, { recursive: true, mode: 0o700 });

  const runId = randomUUID();
  const paths = resolveRunPaths(runId);
  await mkdir(paths.parent, { recursive: false, mode: 0o700 });

  try {
    const spec = buildRunSpec(input);
    await writeFile(paths.spec, `${JSON.stringify(spec, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    const receipt = await runExecutor([
      'prepare',
      '--spec',
      paths.spec,
      '--run-dir',
      paths.run,
    ]);

    return { runId, receipt };
  } catch (error) {
    await rm(paths.parent, { recursive: true, force: true });
    throw error;
  }
}

async function withRun(runId, commandArgs) {
  const paths = resolveRunPaths(runId);
  return runExecutor([...commandArgs, '--run-dir', paths.run]);
}

export function buildMcpServer() {
  const server = new McpServer({
    name: 'nemoengine',
    version: '0.1.0',
  });

  server.registerTool(
    'nemo_prepare',
    {
      description:
        'Prepare a verified NemoEngine 11.5.2 run from the exact current request. Returns a managed runId plus the executor public receipt. Use inspect mode for configuration diagnosis and generate mode before delivery.',
      inputSchema: prepareSchema,
    },
    async (input) => {
      try {
        const { runId, receipt } = await prepareRun(input);
        return textResult(`runId: ${runId}\n${receipt}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'nemo_status',
    {
      description:
        'Read the public executor status for a previously prepared NemoEngine run. This does not read private run files.',
      inputSchema: runIdSchema,
    },
    async ({ runId }) => {
      try {
        return textResult(await withRun(runId, ['status']));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'nemo_next',
    {
      description:
        'Return the complete pending verified delivery frame for a generate run. Read the entire footer before acknowledging it with nemo_advance.',
      inputSchema: runIdSchema,
    },
    async ({ runId }) => {
      try {
        return textResult(await withRun(runId, ['next']));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'nemo_advance',
    {
      description:
        'Acknowledge one fully seen NemoEngine delivery unit using the exact unit index, SHA-256, and footer receipt, then atomically return the next frame or ready_to_draft receipt.',
      inputSchema: advanceSchema,
    },
    async ({ runId, unit, sha256, receipt }) => {
      try {
        const output = await withRun(runId, [
          'advance',
          '--unit',
          String(unit),
          '--sha256',
          sha256,
          '--receipt',
          receipt,
        ]);
        return textResult(output);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'nemo_finish',
    {
      description:
        'Submit the final draft for executor sanitization and return only the verified sanitized user-facing output via show-output. Call only after the run reaches ready_to_draft.',
      inputSchema: finishSchema,
    },
    async ({ runId, draft }) => {
      const paths = resolveRunPaths(runId);
      let completed = false;
      try {
        await writeFile(paths.draft, draft, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'w',
        });

        await runExecutor([
          'finish',
          '--run-dir',
          paths.run,
          '--draft',
          paths.draft,
        ]);

        const output = await runExecutor([
          'show-output',
          '--run-dir',
          paths.run,
        ]);
        completed = true;
        return textResult(output);
      } catch (error) {
        return errorResult(error);
      } finally {
        if (completed) {
          await unlink(paths.draft).catch(() => {});
        }
      }
    },
  );

  server.registerTool(
    'nemo_discard_run',
    {
      description:
        'Delete one managed temporary NemoEngine run after completion or when a task changes and the stale run must be abandoned. This cannot address paths outside the MCP run root.',
      inputSchema: runIdSchema,
    },
    async ({ runId }) => {
      try {
        const { parent } = resolveRunPaths(runId);
        await rm(parent, { recursive: true, force: false });
        return textResult(`discarded runId: ${runId}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export function startHttpServer({
  port = parsePort(process.env.PORT || String(DEFAULT_PORT)),
  host = process.env.HOST || '0.0.0.0',
} = {}) {
  const handler = createMcpHandler(buildMcpServer, {
    onerror: (error) => {
      console.error('[nemoengine-mcp]', error.message);
    },
  });
  const nodeHandler = toNodeHandler(handler);

  const httpServer = createServer((req, res) => {
    const pathname = (req.url || '/').split('?', 1)[0];

    if (pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, service: 'nemoengine-mcp' }));
      return;
    }

    if (pathname !== MCP_ENDPOINT_PATH) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }

    void nodeHandler(req, res);
  });

  httpServer.listen(port, host, () => {
    console.error(
      `[nemoengine-mcp] listening on http://${host}:${port}${MCP_ENDPOINT_PATH}`,
    );
  });

  return httpServer;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === THIS_FILE) {
  startHttpServer();
}

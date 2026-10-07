import { timingSafeEqual } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const DARYA_OWNER = 'producesplatinum-ai';
const DARYA_REPO = 'Darya-Krasavina';
const DARYA_BRANCH = 'main';

export const DARYA_ROUTES = Object.freeze({
  general: Object.freeze([
    'references/darya-core.md',
    'references/darya-speech-transfer.md',
  ]),
  deep_profile: Object.freeze([
    'references/darya-linguistic-deep-profile.md',
  ]),
  adult_core: Object.freeze([
    'references/darya-core.md',
    'references/darya-adult-routing.md',
    'references/darya-adult-role-humiliation.md',
  ]),
  adult_scene: Object.freeze([
    'references/darya-adult-scene-prose.md',
    'references/darya-nemoengine-adult-bridge.md',
    'references/darya-nemoengine-stack-v3.json',
  ]),
  visual: Object.freeze([
    'references/darya-core.md',
    'references/darya-face-total-passport.md',
    'references/darya-face-assets.json',
  ]),
  video: Object.freeze([
    'references/darya-video-grounding.md',
  ]),
  written: Object.freeze([
    'references/darya-core.md',
    'references/darya-written-evidence.md',
  ]),
  diary_evidence: Object.freeze([
    'references/darya-diary-evidence.md',
  ]),
  routing: Object.freeze([
    'SKILL.md',
  ]),
});

const daryaRouteSchema = z.enum(Object.keys(DARYA_ROUTES));

export function normalizeDaryaEndpointPath(value = '/darya/mcp') {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('DARYA_MCP_ENDPOINT_PATH must be an absolute URL path.');
  }

  const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  if (!normalized.endsWith('/mcp')) {
    throw new Error('DARYA_MCP_ENDPOINT_PATH must end with /mcp.');
  }

  return normalized;
}

export function safeBearerMatches(header, expectedToken) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false;

  const actual = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(expectedToken);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nemoengine-darya-native-tavern-sync',
  };
}

export function createDaryaGitHubClient({
  token,
  fetchFn = fetch,
  owner = DARYA_OWNER,
  repo = DARYA_REPO,
  branch = DARYA_BRANCH,
} = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('Darya GitHub token is required.');
  }

  const cleanToken = token.trim();
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

  async function request(path) {
    const response = await fetchFn(`${baseUrl}${path}`, {
      headers: githubHeaders(cleanToken),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Darya GitHub request failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    return response;
  }

  async function currentRevision() {
    const response = await request(`/branches/${encodeURIComponent(branch)}`);
    const data = await response.json();
    const sha = data?.commit?.sha;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new Error('Darya GitHub branch response did not include commit SHA.');
    }
    return sha;
  }

  async function readFile(filePath) {
    if (
      typeof filePath !== 'string' ||
      filePath.length === 0 ||
      filePath.startsWith('/') ||
      filePath.includes('..')
    ) {
      throw new Error('Invalid Darya repository path.');
    }

    const encodedPath = encodeURIComponent(filePath);
    const response = await request(
      `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    );
    const data = await response.json();

    if (
      Array.isArray(data) ||
      data?.type !== 'file' ||
      typeof data.content !== 'string'
    ) {
      throw new Error(`Darya repository path is not a file: ${filePath}`);
    }

    const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');

    return {
      path: filePath,
      sha: typeof data.sha === 'string' ? data.sha : '',
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  }

  async function readRoute(route) {
    const files = DARYA_ROUTES[route];
    if (!files) throw new Error(`Unknown Darya route: ${route}`);

    const [revision, ...sections] = await Promise.all([
      currentRevision(),
      ...files.map((filePath) => readFile(filePath)),
    ]);

    return {
      revision,
      branch,
      route,
      files: [...files],
      totalBytes: sections.reduce((sum, item) => sum + item.bytes, 0),
      payload: sections
        .map(
          (item) =>
            `===== BEGIN ${item.path} blob=${item.sha} =====\n${item.text}\n===== END ${item.path} =====`,
        )
        .join('\n\n'),
    };
  }

  return {
    branch,
    currentRevision,
    readFile,
    readRoute,
  };
}

function textResult(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Darya GitHub sync error: ${message}` }],
    isError: true,
  };
}

export function buildDaryaMcpServer(client) {
  if (!client) throw new Error('Darya GitHub client is required.');

  const server = new McpServer({
    name: 'darya-github-live-sync',
    version: '1.0.0',
  });

  server.registerTool(
    'darya_revision',
    {
      description:
        'Return the current main-branch GitHub revision for Darya. Call before a Darya response to detect source changes without touching NativeTavern chats or memory.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = {
          revision: await client.currentRevision(),
          branch: client.branch,
          routes: Object.keys(DARYA_ROUTES),
        };
        return textResult(JSON.stringify(result), result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'darya_get_context',
    {
      description:
        'Load exact current Darya files from GitHub main for one route: general, deep_profile, adult_core, adult_scene, visual, video, written, diary_evidence, routing. Read-only: never replace NativeTavern chats, messages, memory, or user state.',
      inputSchema: z.object({
        route: daryaRouteSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route }) => {
      try {
        const bundle = await client.readRoute(route);
        const header = {
          revision: bundle.revision,
          branch: bundle.branch,
          route: bundle.route,
          files: bundle.files,
          totalBytes: bundle.totalBytes,
        };
        return textResult(
          `${JSON.stringify(header)}\n\n${bundle.payload}`,
          header,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

export const info = {
  id: 'darya-source-import',
  name: 'Darya Source Import',
  description: 'Protected file-by-file importer for the private Darya source mirror.',
};

export function sanitizeRelativePath(value) {
  if (typeof value !== 'string') throw new Error('Path is required.');
  const raw = value.trim();
  if (!raw || raw === '.') throw new Error('Invalid path.');
  if (raw.includes('\\') || raw.includes('\0')) throw new Error('Invalid path.');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('Absolute paths are not allowed.');

  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path traversal is not allowed.');
  }
  return normalized;
}

export function isAuthorized(header, token) {
  if (typeof token !== 'string' || token.length < 16) return false;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length);
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function writeUploadedFile({
  root,
  relativePath,
  body,
  expectedSha256,
}) {
  if (!Buffer.isBuffer(body)) throw new Error('Upload body must be bytes.');
  if (!/^[0-9a-f]{64}$/i.test(String(expectedSha256 || ''))) {
    throw new Error('Expected sha256 is required.');
  }

  const safePath = sanitizeRelativePath(relativePath);
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }

  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, safePath);
  const prefix = `${absoluteRoot}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error('Resolved path escaped import root.');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.upload-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }

  return { path: safePath, size: body.length, sha256: digest };
}

function authorize(req, res) {
  const token = process.env.DARYA_IMPORT_TOKEN || '';
  if (!isAuthorized(req.headers.authorization || '', token)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

async function readRawBody(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limitBytes) throw new Error('Upload exceeds 32 MiB limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function init(router) {
  const root = process.env.DARYA_IMPORT_ROOT || '/persistent/darya-source';

  router.get('/status', (req, res) => {
    if (!authorize(req, res)) return;
    res.json({ ok: true, root, writable: true });
  });

  router.post('/file', async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      const body = await readRawBody(req);
      const result = writeUploadedFile({
        root,
        relativePath: req.headers['x-darya-path'],
        body,
        expectedSha256: req.headers['x-darya-sha256'],
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

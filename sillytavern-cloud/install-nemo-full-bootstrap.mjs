import fs from 'node:fs';
import path from 'node:path';

const userDataDir = process.env.SILLYTAVERN_USER_DATA_DIR || '/persistent/data/default-user';
const sourceDir = process.env.NEMO_BOOTSTRAP_SOURCE_DIR || '/usr/local/share/nemo-full-bootstrap';
const fallbackSourceDir =
  process.env.NEMO_BOOTSTRAP_FALLBACK_SOURCE_DIR || '/usr/local/share/nemo-full-bootstrap';
const targetDir = path.join(userDataDir, 'extensions', 'NemoFullBootstrap');

function hasBootstrapSource(dir) {
  return (
    fs.existsSync(path.join(dir, 'manifest.json')) &&
    fs.existsSync(path.join(dir, 'index.js'))
  );
}

if (!hasBootstrapSource(sourceDir) && sourceDir !== fallbackSourceDir && hasBootstrapSource(fallbackSourceDir)) {
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
  fs.cpSync(fallbackSourceDir, sourceDir, { recursive: true, force: true });
  console.log('Nemo Full Bootstrap source recovered from bundled fallback');
}

if (!hasBootstrapSource(sourceDir)) {
  throw new Error('Nemo Full Bootstrap source files are missing.');
}

const tempDir = `${targetDir}.tmp-${process.pid}`;
fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDir), { recursive: true });
fs.cpSync(sourceDir, tempDir, { recursive: true, force: true });
fs.rmSync(targetDir, { recursive: true, force: true });
fs.renameSync(tempDir, targetDir);

const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));
if (manifest.display_name !== 'Nemo Full Bootstrap' || manifest.loading_order !== 1100) {
  throw new Error('Installed Nemo Full Bootstrap manifest is invalid.');
}

console.log('Nemo Full Bootstrap extension installed');

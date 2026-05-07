// Bundle web/ + tools/core/ + assets/ and ship to Berrry.
//
// Reads BERRRY_TOKEN from .env.berrry (gitignored, chmod 600).
// First run POSTs /apps to create the subdomain; subsequent runs PUT.
//
// Path flattening: index.html stays at root, main.js's `../tools/` and
// `../assets/` imports are rewritten to `./tools/` and `./assets/` so
// the bundle is self-contained under the subdomain root.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENV_PATH = resolve(ROOT, '.env.berrry');
const SUBDOMAIN = process.env.BERRRY_SUBDOMAIN ?? '86-dos';
const API = 'https://berrry.app/api/nomcp';

function loadEnv(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Create it with chmod 600 containing BERRRY_TOKEN=<token>.`);
  }
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function readText(rel) { return readFileSync(resolve(ROOT, rel), 'utf8'); }
function readBin(rel)  { return readFileSync(resolve(ROOT, rel)); }

function buildBundle() {
  const indexHtml = readText('web/index.html');
  let mainJs = readText('web/main.js');
  // Flatten parent-dir imports for the deploy bundle.
  mainJs = mainJs
    .replace(/\.\.\/tools\//g, './tools/')
    .replace(/\.\.\/assets\//g, './assets/');
  const glassTty = readText('web/glass_tty.js');

  const coreFiles = [
    'cpu.js', 'cycles_8088.js', 'cycles_8088_eu.js', 'disk_imd.js',
    'instruction_set.js', 'memory.js', 'modrm.js', 'scp_bios.js',
  ];
  const files = [
    { name: 'index.html',    content: indexHtml },
    { name: 'main.js',       content: mainJs },
    { name: 'glass_tty.js',  content: glassTty },
  ];
  for (const f of coreFiles) {
    files.push({ name: `tools/core/${f}`, content: readText(`tools/core/${f}`) });
  }
  files.push({
    name: 'assets/86dos114-tarbell-dd.imd',
    content: readBin('assets/86dos114-tarbell-dd.imd').toString('base64'),
    encoding: 'base64',
  });
  return files;
}

async function appExists(token, sub) {
  const r = await fetch(`${API}/${token}/apps/${sub}/files`);
  return r.ok;
}

async function publish(token, files, exists) {
  const url = exists ? `${API}/${token}/apps/${sub(files)}` : `${API}/${token}/apps`;
  const body = exists
    ? { files, message: `deploy ${new Date().toISOString()}` }
    : {
        subdomain: SUBDOMAIN,
        title: '86-DOS 1.14 — SCP S-100 in the browser',
        description: 'Genuine 86-DOS booted on a JS 8086 with a nine-vector SCP BIOS shim.',
        files,
      };
  const r = await fetch(url, {
    method: exists ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text}`);
  return JSON.parse(text);
}

const sub = () => SUBDOMAIN;

(async () => {
  const env = loadEnv(ENV_PATH);
  const token = env.BERRRY_TOKEN;
  if (!token) throw new Error('BERRRY_TOKEN missing in .env.berrry');

  const files = buildBundle();
  const totalKB = files.reduce((n, f) => n + (f.encoding === 'base64' ? Buffer.from(f.content, 'base64').length : Buffer.byteLength(f.content)), 0) / 1024;
  console.log(`bundle: ${files.length} files, ${totalKB.toFixed(1)} KB`);

  const exists = await appExists(token, SUBDOMAIN);
  console.log(`${exists ? 'updating' : 'creating'} ${SUBDOMAIN}.berrry.app …`);
  const res = await publish(token, files, exists);
  console.log(`✓ ${res.url ?? `https://${SUBDOMAIN}.berrry.app`}  (v${res.version ?? '?'})`);
})().catch(e => { console.error(e.message); process.exit(1); });

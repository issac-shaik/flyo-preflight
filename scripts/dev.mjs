// Starts the mock Flyo API and the Preflight app together (Ctrl+C stops both).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useMock = !process.argv.includes('--no-mock');
const procs = [];

function run(name, file) {
  const p = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = (s) => s.toString().split(/\r?\n/).filter(Boolean).map((l) => `${name.padEnd(9)}| ${l}`).join('\n');
  p.stdout.on('data', (d) => console.log(prefix(d)));
  p.stderr.on('data', (d) => console.error(prefix(d)));
  p.on('exit', (code) => { console.log(`${name} exited (${code})`); shutdown(code ?? 0); });
  procs.push(p);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (useMock) run('mock-flyo', 'src/mock-flyo/server.mjs');
setTimeout(() => run('preflight', 'src/app/server.mjs'), useMock ? 400 : 0);

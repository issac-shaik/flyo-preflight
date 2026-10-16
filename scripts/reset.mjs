// Wipes local demo state (bookings, uploaded files, mock Flyo state). Stop the servers first.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
rmSync(dataDir, { recursive: true, force: true });
console.log(`Removed ${dataDir}`);

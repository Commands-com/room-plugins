import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const manifest = JSON.parse(readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));

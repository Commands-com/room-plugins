import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDemoAssets } from '../lib/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets', 'demo');

describe('loadDemoAssets', () => {
  it('loads schema and query SQL', async () => {
    const assets = await loadDemoAssets();
    expect(assets.schemaSQL).toContain('CREATE TABLE');
    expect(assets.querySQL).toContain('SELECT');
  });

  it('finds a data file path', async () => {
    const assets = await loadDemoAssets();
    // At least one of data.sql.gz or data.sql must exist
    expect(assets.dataPath).not.toBeNull();
    expect(fs.existsSync(assets.dataPath)).toBe(true);
  });
});

describe('demo data file presence', () => {
  it('has at least one data file in assets/demo/', () => {
    const gzExists = fs.existsSync(path.join(ASSETS_DIR, 'data.sql.gz'));
    const plainExists = fs.existsSync(path.join(ASSETS_DIR, 'data.sql'));
    expect(gzExists || plainExists).toBe(true);
  });

  it('has schema.sql in assets/demo/', () => {
    expect(fs.existsSync(path.join(ASSETS_DIR, 'schema.sql'))).toBe(true);
  });

  it('has query.sql in assets/demo/', () => {
    expect(fs.existsSync(path.join(ASSETS_DIR, 'query.sql'))).toBe(true);
  });
});

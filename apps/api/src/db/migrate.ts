import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from './client.js';

export async function runMigrations(): Promise<void> {
  const raw = readFileSync(
    join(new URL('.', import.meta.url).pathname, 'migrations/001_init.sql'),
    'utf8'
  );

  // Split on statement-ending semicolons so each statement runs independently.
  // The postgres driver's unsafe() can silently stop after the first result set
  // in some multi-statement blobs, so we drive each statement ourselves.
  const statements = raw
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean);

  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

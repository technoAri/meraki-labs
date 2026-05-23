import { readFileSync } from 'fs';
import { join } from 'path';
import { sql } from './client.js';

export async function runMigrations(): Promise<void> {
  const migrationSql = readFileSync(
    join(new URL('.', import.meta.url).pathname, 'migrations/001_init.sql'),
    'utf8'
  );
  await sql.unsafe(migrationSql);
}

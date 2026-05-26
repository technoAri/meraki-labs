import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

// Primary — all writes and normal reads
export const sql = postgres(DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
});

// Replica — read fallback if primary is unreachable
const DATABASE_READ_URL = process.env.DATABASE_READ_URL;
const sqlReplica = DATABASE_READ_URL
  ? postgres(DATABASE_READ_URL, { max: 10, idle_timeout: 30, connect_timeout: 5 })
  : null;

// All reads go to primary. If primary is unreachable, falls back to replica.
export async function readWithFallback<T>(
  queryFn: (db: postgres.Sql) => Promise<T>
): Promise<T> {
  try {
    return await queryFn(sql);
  } catch (err) {
    if (sqlReplica) {
      return await queryFn(sqlReplica);
    }
    throw err;
  }
}

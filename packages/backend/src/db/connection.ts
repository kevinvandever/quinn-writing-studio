import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config.js';

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Handle pool-level errors to prevent process crashes
pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle database client:', err.message);
});

/**
 * Execute a query using the connection pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Get a client from the pool for transaction support.
 * Caller is responsible for releasing the client.
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Gracefully close the connection pool.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}

export { pool };

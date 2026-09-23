import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * ALTER TYPE ... ADD VALUE historically could not run inside a transaction
 * block. PostgreSQL 12+ permits it provided the new value isn't used in the same
 * transaction, but disabling the wrapping transaction keeps this safe regardless
 * of server version.
 */
export const disableTransaction = true;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Adds the 'writing_jobs' category so the Intelligence feed can track paid
  // writing work alongside grants, AI news, and publishing opportunities.
  pgm.sql(`ALTER TYPE intelligence_category ADD VALUE IF NOT EXISTS 'writing_jobs'`);
}

export async function down(): Promise<void> {
  // PostgreSQL provides no supported way to remove a value from an enum type
  // (it would require recreating the type and rewriting dependent columns).
  // Leaving the value in place is harmless, so this is intentionally a no-op.
}

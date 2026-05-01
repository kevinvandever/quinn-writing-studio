import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('api_usage_logs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    model: {
      type: 'varchar(50)',
      notNull: true,
    },
    feature_area: {
      type: 'varchar(50)',
      notNull: true,
    },
    input_tokens: {
      type: 'integer',
      notNull: true,
    },
    output_tokens: {
      type: 'integer',
      notNull: true,
    },
    estimated_cost_usd: {
      type: 'decimal(10,6)',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('api_usage_logs', 'user_id');
  pgm.createIndex('api_usage_logs', 'created_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('api_usage_logs');
}

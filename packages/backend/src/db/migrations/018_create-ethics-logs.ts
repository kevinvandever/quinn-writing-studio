import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('ethics_logs', {
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
    session_id: {
      type: 'uuid',
      notNull: true,
      references: 'sessions',
      onDelete: 'CASCADE',
    },
    user_message: {
      type: 'text',
      notNull: true,
    },
    quinn_response: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('ethics_logs', 'user_id');
  pgm.createIndex('ethics_logs', 'session_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('ethics_logs');
}

import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('capture_status', ['inbox', 'triaged', 'dismissed']);

  pgm.createTable('quick_captures', {
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
    project_id: {
      type: 'uuid',
      references: 'projects',
      onDelete: 'SET NULL',
    },
    content: {
      type: 'text',
      notNull: true,
    },
    status: {
      type: 'capture_status',
      notNull: true,
      default: "'inbox'",
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('quick_captures', 'user_id');
  pgm.createIndex('quick_captures', 'project_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('quick_captures');
  pgm.dropType('capture_status');
}

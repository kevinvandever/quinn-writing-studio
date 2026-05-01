import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('promptly_status', ['selected', 'in_progress', 'published', 'dropped']);

  pgm.createTable('promptly_queue_items', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'projects',
      onDelete: 'CASCADE',
    },
    intelligence_item_id: {
      type: 'uuid',
      notNull: true,
      references: 'intelligence_items',
      onDelete: 'CASCADE',
    },
    status: {
      type: 'promptly_status',
      notNull: true,
      default: "'selected'",
    },
    substack_post_id: {
      type: 'varchar(255)',
    },
    coaching_session_id: {
      type: 'uuid',
      references: 'sessions',
      onDelete: 'SET NULL',
    },
    notes: {
      type: 'text',
    },
    selected_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    published_at: {
      type: 'timestamptz',
    },
  });

  pgm.createIndex('promptly_queue_items', 'project_id');
  pgm.createIndex('promptly_queue_items', 'intelligence_item_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('promptly_queue_items');
  pgm.dropType('promptly_status');
}

import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('activity_event_type', [
    'scrivener_import',
    'substack_publish',
    'session_start',
    'session_end',
    'capture_created',
    'goal_completed',
  ]);

  pgm.createTable('activity_events', {
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
    event_type: {
      type: 'activity_event_type',
      notNull: true,
    },
    metadata: {
      type: 'jsonb',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('activity_events', 'user_id');
  pgm.createIndex('activity_events', 'project_id');
  pgm.createIndex('activity_events', 'created_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('activity_events');
  pgm.dropType('activity_event_type');
}

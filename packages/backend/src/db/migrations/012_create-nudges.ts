import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('nudge_type', ['quiet_period', 'goal_behind', 'deadline_approaching', 'celebration', 'stale_corpus']);
  pgm.createType('nudge_urgency', ['gentle', 'warm', 'direct']);

  pgm.createTable('nudges', {
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
    nudge_type: {
      type: 'nudge_type',
      notNull: true,
    },
    urgency: {
      type: 'nudge_urgency',
      notNull: true,
    },
    content: {
      type: 'text',
      notNull: true,
    },
    reference_id: {
      type: 'uuid',
    },
    delivered_via: {
      type: 'varchar[]',
      default: "'{in_app}'",
    },
    acknowledged_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('nudges', 'user_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('nudges');
  pgm.dropType('nudge_urgency');
  pgm.dropType('nudge_type');
}

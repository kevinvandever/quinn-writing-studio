import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('goal_type', ['word_count', 'session_frequency', 'milestone']);
  pgm.createType('goal_period', ['daily', 'weekly', 'monthly', 'one_time']);
  pgm.createType('goal_status', ['active', 'completed', 'paused']);

  pgm.createTable('goals', {
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
    goal_type: {
      type: 'goal_type',
      notNull: true,
    },
    title: {
      type: 'varchar(255)',
      notNull: true,
    },
    target_value: {
      type: 'integer',
      notNull: true,
    },
    target_unit: {
      type: 'varchar(50)',
      notNull: true,
    },
    period: {
      type: 'goal_period',
      notNull: true,
    },
    current_value: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    status: {
      type: 'goal_status',
      notNull: true,
      default: "'active'",
    },
    behind_threshold: {
      type: 'float',
      default: 0.2,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    due_date: {
      type: 'date',
    },
  });

  pgm.createIndex('goals', 'project_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('goals');
  pgm.dropType('goal_status');
  pgm.dropType('goal_period');
  pgm.dropType('goal_type');
}

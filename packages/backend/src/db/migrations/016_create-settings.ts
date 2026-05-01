import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('model_routing_preference', ['auto', 'always_sonnet', 'always_opus']);

  pgm.createTable('settings', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    anthropic_api_key: {
      type: 'text',
    },
    model_routing_preference: {
      type: 'model_routing_preference',
      notNull: true,
      default: "'auto'",
    },
    quiet_period_thresholds: {
      type: 'jsonb',
      default: "'{\"gentle\":3,\"warm\":7,\"direct\":14}'",
    },
    stale_corpus_threshold_days: {
      type: 'integer',
      default: 7,
    },
    email_notifications_enabled: {
      type: 'boolean',
      default: false,
    },
    notification_email: {
      type: 'varchar(255)',
    },
    vacation_start: {
      type: 'date',
    },
    vacation_end: {
      type: 'date',
    },
    intelligence_schedules: {
      type: 'jsonb',
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('settings');
  pgm.dropType('model_routing_preference');
}

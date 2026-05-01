import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('session_type', ['coaching', 'editorial_review', 'theme_analysis', 'promptly_coaching']);

  pgm.createTable('sessions', {
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
    session_type: {
      type: 'session_type',
      notNull: true,
    },
    summary: {
      type: 'text',
    },
    next_steps: {
      type: 'text',
    },
    started_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    ended_at: {
      type: 'timestamptz',
    },
  });

  pgm.createIndex('sessions', 'project_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('sessions');
  pgm.dropType('session_type');
}

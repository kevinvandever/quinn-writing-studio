import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('message_role', ['user', 'assistant', 'system']);

  pgm.createTable('messages', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    session_id: {
      type: 'uuid',
      notNull: true,
      references: 'sessions',
      onDelete: 'CASCADE',
    },
    role: {
      type: 'message_role',
      notNull: true,
    },
    content: {
      type: 'text',
      notNull: true,
    },
    model_used: {
      type: 'varchar(50)',
    },
    model_reason: {
      type: 'text',
    },
    token_count_input: {
      type: 'integer',
    },
    token_count_output: {
      type: 'integer',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('messages', 'session_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('messages');
  pgm.dropType('message_role');
}

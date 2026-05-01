import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('sync_status', ['ok', 'error', 'never_synced']);

  pgm.createTable('substack_connections', {
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
    publication_url: {
      type: 'varchar(500)',
      notNull: true,
    },
    publication_name: {
      type: 'varchar(255)',
    },
    auth_cookies: {
      type: 'text',
    },
    last_sync_at: {
      type: 'timestamptz',
    },
    sync_status: {
      type: 'sync_status',
      notNull: true,
      default: "'never_synced'",
    },
    sync_error: {
      type: 'text',
    },
  });

  pgm.createIndex('substack_connections', 'project_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('substack_connections');
  pgm.dropType('sync_status');
}

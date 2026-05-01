import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('snapshot_trigger', ['manual', 'pre_import_update']);

  pgm.createTable('draft_snapshots', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    document_id: {
      type: 'uuid',
      notNull: true,
      references: 'corpus_documents',
      onDelete: 'CASCADE',
    },
    content: {
      type: 'text',
      notNull: true,
    },
    word_count: {
      type: 'integer',
    },
    trigger: {
      type: 'snapshot_trigger',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('draft_snapshots', 'document_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('draft_snapshots');
  pgm.dropType('snapshot_trigger');
}

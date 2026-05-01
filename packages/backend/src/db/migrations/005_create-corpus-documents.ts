import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('corpus_source_type', ['scrivener', 'substack', 'manual_upload', 'quick_capture']);

  pgm.createTable('corpus_documents', {
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
    source_type: {
      type: 'corpus_source_type',
      notNull: true,
    },
    source_id: {
      type: 'varchar(255)',
    },
    title: {
      type: 'varchar(500)',
    },
    content: {
      type: 'text',
    },
    content_hash: {
      type: 'varchar(64)',
    },
    word_count: {
      type: 'integer',
    },
    parent_id: {
      type: 'uuid',
      references: 'corpus_documents',
      onDelete: 'SET NULL',
    },
    sort_order: {
      type: 'integer',
    },
    is_folder: {
      type: 'boolean',
      default: false,
    },
    metadata: {
      type: 'jsonb',
    },
    import_id: {
      type: 'uuid',
      // FK added in scrivener_imports migration
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('corpus_documents', 'project_id');
  pgm.createIndex('corpus_documents', 'parent_id');
  pgm.createIndex('corpus_documents', 'import_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('corpus_documents');
  pgm.dropType('corpus_source_type');
}

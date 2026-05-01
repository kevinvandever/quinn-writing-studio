import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('scrivener_imports', {
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
    filename: {
      type: 'varchar(500)',
      notNull: true,
    },
    s3_key: {
      type: 'varchar(500)',
    },
    document_count: {
      type: 'integer',
    },
    total_word_count: {
      type: 'integer',
    },
    parse_errors: {
      type: 'jsonb',
    },
    diff_summary: {
      type: 'jsonb',
    },
    imported_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('scrivener_imports', 'project_id');

  // Add FK from corpus_documents.import_id -> scrivener_imports.id
  pgm.addConstraint('corpus_documents', 'corpus_documents_import_id_fkey', {
    foreignKeys: {
      columns: 'import_id',
      references: 'scrivener_imports(id)',
      onDelete: 'SET NULL',
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('corpus_documents', 'corpus_documents_import_id_fkey');
  pgm.dropTable('scrivener_imports');
}

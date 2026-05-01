import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('theme_connections', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    document_a_id: {
      type: 'uuid',
      notNull: true,
      references: 'corpus_documents',
      onDelete: 'CASCADE',
    },
    document_b_id: {
      type: 'uuid',
      notNull: true,
      references: 'corpus_documents',
      onDelete: 'CASCADE',
    },
    theme: {
      type: 'varchar(255)',
      notNull: true,
    },
    explanation: {
      type: 'text',
    },
    strength: {
      type: 'float',
    },
    discovered_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.createIndex('theme_connections', 'document_a_id');
  pgm.createIndex('theme_connections', 'document_b_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('theme_connections');
}

import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate' with { "resolution-mode": "import" };

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createType('intelligence_category', ['grant', 'ai_news', 'publishing']);
  pgm.createType('intelligence_status', ['new', 'reviewed', 'selected', 'saved', 'dismissed']);

  pgm.createTable('intelligence_items', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    category: {
      type: 'intelligence_category',
      notNull: true,
    },
    subcategory: {
      type: 'varchar(100)',
    },
    title: {
      type: 'varchar(500)',
      notNull: true,
    },
    source: {
      type: 'varchar(500)',
    },
    source_name: {
      type: 'varchar(255)',
    },
    summary: {
      type: 'text',
    },
    relevance_score: {
      type: 'float',
    },
    deadline: {
      type: 'date',
    },
    eligibility_summary: {
      type: 'text',
    },
    award_details: {
      type: 'text',
    },
    status: {
      type: 'intelligence_status',
      notNull: true,
      default: "'new'",
    },
    published_at: {
      type: 'timestamptz',
    },
    discovered_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    reviewed_at: {
      type: 'timestamptz',
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('intelligence_items');
  pgm.dropType('intelligence_status');
  pgm.dropType('intelligence_category');
}

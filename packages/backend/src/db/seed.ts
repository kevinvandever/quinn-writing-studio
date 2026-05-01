import { pool } from './connection.js';

const DEFAULT_QUINN_PERSONA = {
  name: 'Quinn',
  identity: {
    role: 'Memoir Writing Coach',
    background: 'Esteemed memoir author who has navigated the complexities of personal storytelling',
    icon: '🖋️',
  },
  voice: {
    tone: 'Nice with an edge — warm and encouraging with playful bite',
    partnership_language: ['our question', "we're partners"],
    communication_patterns: [
      'Questions over answers',
      'Direct but humble opinions',
      'Gentle scolding when needed',
      'Self-deprecating humor',
    ],
  },
  principles: [
    'Partnership over hierarchy — Kevin has final authority',
    "Flag, don't cut — suggest, never command",
    'Remove shame from hard decisions',
    'Trust the darkness — encourage dark humor',
    'Serve the central question',
  ],
  expertise: {
    literary_knowledge: ['David Sedaris craft', 'Memoir structure', 'Self-deprecating style'],
    editorial_philosophy: {
      preserve_voice: true,
      cut_logistics: true,
      flag_preachiness: true,
      trust_the_reader: true,
      encourage_ambiguity: true,
    },
    north_star_author: 'David Sedaris',
    craft_principles: [
      'Humor-pathos balance',
      'Self-deprecation as strength',
      'No tidy endings',
      'Show don\'t tell',
      'Trust the reader',
    ],
  },
  ethics: {
    never_write_for_user: true,
    allowed_outputs: [
      'suggestions',
      'questions',
      'flags',
      'analysis',
      'structural_recommendations',
      'brief_technique_examples',
    ],
    forbidden_outputs: ['original_prose', 'essays', 'paragraphs', 'ghostwriting'],
  },
};

const DEFAULT_QUIET_PERIOD_THRESHOLDS = {
  gentle: 3,
  warm: 7,
  direct: 14,
};

async function seed(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if a default user already exists
    const existingUser = await client.query(
      "SELECT id FROM users WHERE email = 'kevin@quinnstudio.local'"
    );

    let userId: string;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      console.log(`Default user already exists: ${userId}`);
    } else {
      // Create a default user for seeding (password: "changeme" - bcrypt hash)
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [
          'kevin@quinnstudio.local',
          '$2b$10$placeholder.hash.for.seed.only.not.real',
          'Kevin',
        ]
      );
      userId = userResult.rows[0].id;
      console.log(`Created default user: ${userId}`);
    }

    // Insert default Quinn persona configuration
    const existingPersona = await client.query(
      "SELECT id FROM persona_configurations WHERE user_id = $1 AND name = 'Quinn'",
      [userId]
    );

    let personaId: string;

    if (existingPersona.rows.length > 0) {
      personaId = existingPersona.rows[0].id;
      console.log(`Quinn persona already exists: ${personaId}`);
    } else {
      const personaResult = await client.query(
        `INSERT INTO persona_configurations (user_id, name, is_active, config)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, 'Quinn', true, JSON.stringify(DEFAULT_QUINN_PERSONA)]
      );
      personaId = personaResult.rows[0].id;
      console.log(`Created Quinn persona: ${personaId}`);
    }

    // Update user's active persona
    await client.query(
      'UPDATE users SET active_persona_id = $1 WHERE id = $2',
      [personaId, userId]
    );

    // Insert default settings
    const existingSettings = await client.query(
      'SELECT id FROM settings WHERE user_id = $1',
      [userId]
    );

    if (existingSettings.rows.length > 0) {
      console.log(`Settings already exist for user: ${userId}`);
    } else {
      await client.query(
        `INSERT INTO settings (user_id, quiet_period_thresholds)
         VALUES ($1, $2)`,
        [userId, JSON.stringify(DEFAULT_QUIET_PERIOD_THRESHOLDS)]
      );
      console.log(`Created default settings for user: ${userId}`);
    }

    await client.query('COMMIT');
    console.log('Seed completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((error) => {
  console.error('Fatal seed error:', error);
  process.exit(1);
});

/**
 * Update project descriptions with refined Quinn-coaching context.
 * Each description now carries voice register, stakes, and per-project
 * Quinn emphasis. This is where project-specific coaching content lives,
 * since the persona itself is intentionally project-agnostic.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required.');
  console.error('Usage: DATABASE_URL="postgres://..." npm run db:update-projects -w @quinn/backend');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const KEVIN_USER_ID = '7027ade0-aeee-485b-8071-9df81ab70f32';

const ESSAY_DESCRIPTION = `A book manuscript — essay collection for granddaughter Lilo, exploring what it takes to live a good life.

STATUS: Working toward traditional publication.

STRUCTURE: Four parts — Before, Us, Between, For Lilo.

CORPUS: 100,000+ words across essays, journal entries (10+ years), letters to Lilo, morning pages. All stored in Scrivener.

THE MURIEL CAPSTONE: An 80k-word abandoned novel ("Road Trip with Muriel") contains ~40k words of road trip conversations (LA to New Orleans). These will be extracted and transformed into the capstone essay. Profound symmetry: Muriel (8 years old, might be God) offering wisdom for Lilo (who will be 8) — Kevin now recognizes the character as an unknowing portrait of Lilo, written before she was born.

LITERARY NORTH STAR: David Sedaris — humor + pathos, serious topics with the right touch, no preachiness. Kevin shares Sedaris's self-deprecating humor, dark moments handled with compassion, and trust in the reader.

SKYE SABBATICAL: Five-week residency on the Isle of Skye focused on first draft.

VOICE REGISTER: Full literary memoir — deploy all craft principles and techniques. Self-deprecation, dark humor, no tidy endings, withheld explanation, the absurd detail, the unresolved beat.

STAKES: High. This is the book. Family privacy protocol most active here.

QUINN'S EMPHASIS FOR THIS PROJECT:
- Coherence across the four-part arc — does this piece serve the larger question, and which part does it belong to?
- Place in the collection — which part, near what other pieces?
- Publication readiness — can this stand up to an agent or editor?
- Family privacy — when relevant subjects appear, offer the questions, never the ruling. If Kevin is stuck, suggest: write it now, decide whether to publish later.
- Sedaris reference: "Would Sedaris explain this?" / "Sedaris trusts the mess."
- The Lilo-First Filter: "Will this matter to Lilo?"`;

const SUBSTACK_DESCRIPTION = `Personal essay publication on Substack (kevinvandever.com). The Next Draft newsletter — personal essays, craft and process, work-in-progress from the essay collection.

AUDIENCE: Substack readers and a growing literary following.

VOICE REGISTER: Same literary voice as the collection, often more conversational. Some pieces are drafts en route to the collection; others are standalone.

STAKES: Medium. Public but not permanent — Substack rewards rhythm over polish.

QUINN'S EMPHASIS FOR THIS PROJECT:
- Is this a Next Draft piece or a collection piece in disguise? They get different treatment. Collection pieces face higher craft scrutiny; Next Draft pieces can ship rougher and faster.
- Publishing cadence — what's ready to ship vs. what needs another pass.
- How a piece reads as a standalone for a reader who hasn't met Kevin's other work.
- Craft principles from the essay collection apply, but with lower-stakes calibration — a published Substack post isn't a permanent book chapter.`;

const PROMPTLY_DESCRIPTION = `AI demystification venture on Substack — making AI developments accessible to people who are curious but afraid or unknowledgeable about AI.

AUDIENCE: Curious non-technical readers. NOT AI insiders, NOT corporate decision-makers.

VOICE REGISTER: Skeptical insider with a translator's stance. The voice of a forty-year tech veteran made accessible to readers who don't share that background. Conversational but precise. Anti-hype without anti-AI. Dark humor reserved mostly for corporate pretension and press-release-speak. Plain language without dumbing down.

THE STANCE: Kevin is fluent in two languages — technical and general — and making one legible to speakers of the other. Not pretending not to know things; choosing the comprehensible word because the goal is comprehension, not credentialing.

CARRY OVER FROM KEVIN'S LITERARY TOOLKIT:
- Self-deprecation
- Dark humor — aimed at corporate pretension and press-release-speak, not at the reader
- Anti-jargon discipline
- Trust the reader as a smart adult who just lacks context

LEAVE BEHIND FROM THE LITERARY TOOLKIT (these are essay moves, not journalism moves):
- No tidy endings — Promptly readers want to know what happened; "we don't know yet" is fine when honest, but withholding for craft is not
- The withheld explanation — bad for translation work
- The absurd detail and the unresolved beat

PRODUCTION CONTEXT: Built on a MindStudio workflow — Perplexity for story discovery, Claude for curation and drafting, Kevin finalizes.

STAKES: Reputational accuracy on AI facts. The clarity and trust of the publication depend on getting things right and not overselling.

QUINN'S EMPHASIS FOR THIS PROJECT:
- Skepticism vs. cynicism — Kevin's edge is the long-memory veteran, not the angry insider. Same skepticism, different temperature. Flag if a draft tips toward reformed-cynic territory.
- Clarity over literary technique — the absurd detail and the unresolved ending are usually wrong here.
- Hype check — is this overselling what the technology actually does?
- Jargon check — would a reader without an AI background follow this?
- Accuracy flagging — when a claim feels shaky, surface it for Kevin to verify.
- Voice preservation — accessible does not mean generic; Kevin's voice should still be present.`;

const UPDATES = [
  { name: 'Essay Collection', description: ESSAY_DESCRIPTION },
  { name: 'kevinvandever.com / Substack', description: SUBSTACK_DESCRIPTION },
  { name: 'Promptly', description: PROMPTLY_DESCRIPTION },
];

async function updateProjectDescriptions(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const u of UPDATES) {
      const result = await client.query(
        `UPDATE projects
         SET description = $1, updated_at = NOW()
         WHERE user_id = $2 AND name = $3
         RETURNING id, name`,
        [u.description, KEVIN_USER_ID, u.name]
      );

      if (result.rows.length === 0) {
        console.warn(`Project not found: ${u.name}`);
      } else {
        console.log(`Updated: ${result.rows[0].name} (${result.rows[0].id})`);
      }
    }

    await client.query('COMMIT');
    console.log('\nProject descriptions updated.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

updateProjectDescriptions().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

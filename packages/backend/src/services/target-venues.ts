/**
 * Target Venues
 *
 * A curated list of literary venues that fit the writer's material (reflective
 * memoir and personal essay). This exists so Quinn's placement advice rests on a
 * list the writer controls, rather than on whatever journals the model happens to
 * recall — and so word-count fit can be checked mechanically where the limit is
 * known and stable.
 *
 * IMPORTANT: treat every detail here as the writer's working notes, NOT verified
 * fact. Reading periods, fees, pay rates, and word limits change frequently.
 * Quinn is instructed to tell the writer to confirm current guidelines on the
 * venue's own site before submitting. Only `site` (base domain) and `maxWords`
 * for hard-format venues are treated as reliable, and even those are worth a look.
 *
 * To add a venue, append to TARGET_VENUES — the scanner's search queries and the
 * coaching context are both derived from this array.
 */

export interface TargetVenue {
  /** Venue name as the writer refers to it. */
  name: string;
  /** Base site (not a deep submissions path, which changes more often). */
  site: string;
  /** Why this venue suits the writer's work. */
  fit: string;
  /**
   * How hard it is to place here.
   * 'reach' = long shot, 'mid' = plausible, 'accessible' = better odds.
   * Fit and difficulty are separate: a venue can be an excellent fit and still
   * be a long shot.
   */
  difficulty: 'reach' | 'mid' | 'accessible';
  /** Hard word ceiling where the venue's format defines one. */
  maxWords?: number;
  /** Anything procedural worth knowing — caps, timing, pay. Unverified. */
  notes?: string;
}

export const TARGET_VENUES: TargetVenue[] = [
  {
    name: 'Brevity',
    site: 'brevitymag.com',
    fit: 'Flash nonfiction only. A credit here carries disproportionate respect, and short pieces are cheap to attempt.',
    difficulty: 'reach',
    maxWords: 750,
    notes: 'Flash nonfiction, 750 words maximum — a hard format constraint, so only short pieces qualify.',
  },
  {
    name: 'The Sun',
    site: 'thesunmagazine.org',
    fit: 'Plainspoken personal essay, no MFA-insider taste. Likely the strongest fit for this writer\'s voice.',
    difficulty: 'reach',
    notes: 'Pays well. Excellent fit but highly competitive — strong fit does not mean good odds.',
  },
  {
    name: 'River Teeth',
    site: 'riverteethjournal.com',
    fit: 'Built for exactly this kind of narrative nonfiction.',
    difficulty: 'reach',
    notes: 'Narrative nonfiction focus; check current reading period.',
  },
  {
    name: 'The Forge',
    site: 'forgelitmag.com',
    fit: 'Contemporary literary work; open to personal narrative.',
    difficulty: 'mid',
    notes: 'Free submissions reportedly open the 1st of each month and close at ~200 submissions; pays around $100. Submit early in the month.',
  },
  {
    name: 'New England Review',
    site: 'nereview.com',
    fit: 'Publishes both emerging and established writers; regionally resonant for a New England vantage.',
    difficulty: 'reach',
    notes: 'Competitive — a long shot worth taking.',
  },
  {
    name: 'Hippocampus Magazine',
    site: 'hippocampusmagazine.com',
    fit: 'Memoir-specific, which suits this work directly.',
    difficulty: 'mid',
    notes: 'Mid-tier, memoir-focused; more forgiving odds than the reaches.',
  },
  {
    name: 'Under the Gum Tree',
    site: 'underthegumtree.com',
    fit: 'Memoir and personal narrative, receptive to reflective work.',
    difficulty: 'mid',
    notes: 'Mid-tier, memoir-focused; more forgiving odds than the reaches.',
  },
];

/**
 * Build the coaching-prompt section describing the target venues.
 * Included for placement-oriented commands (/place-this, /submission-ready).
 */
export function buildTargetVenuesContext(): string {
  const lines: string[] = [
    '## Target Venues (the writer\'s curated shortlist)',
    'These are venues the writer has chosen as targets for this work. Prefer these when recommending where to send a piece, alongside any live open calls from the Intelligence feed. You may suggest venues beyond this list when a piece clearly calls for it, but say why.',
    '',
    'Every detail below is the writer\'s working notes, NOT verified fact — reading periods, fees, pay, and limits change. Always tell the writer to confirm current guidelines on the venue\'s own site. Never state a deadline or fee as certain.',
    '',
  ];

  for (const v of TARGET_VENUES) {
    const bits = [`- ${v.name} (${v.site}) — ${v.difficulty}`];
    if (v.maxWords) bits.push(`— HARD LIMIT ${v.maxWords} words`);
    lines.push(bits.join(' '));
    lines.push(`    Fit: ${v.fit}`);
    if (v.notes) lines.push(`    Notes: ${v.notes}`);
  }

  lines.push(
    '',
    'When recommending: check the piece\'s word count against any hard limit before suggesting a venue — length disqualifies more submissions than quality does. Offer a mixed slate (a couple of reaches, a few mid-tier) since simultaneous submissions are standard practice.'
  );

  return lines.join('\n');
}

/**
 * Search queries derived from the venue list, so the scanner tracks THESE
 * venues' reading periods rather than only whatever the open web surfaces.
 */
export function venueSearchQueries(): string[] {
  return TARGET_VENUES.map((v) => `${v.name} submissions open reading period guidelines`);
}

/** Lowercased venue names, for relevance matching in the scanner. */
export function venueNamesLower(): string[] {
  return TARGET_VENUES.map((v) => v.name.toLowerCase());
}

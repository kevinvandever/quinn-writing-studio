/**
 * Coaching Workflows & Commands
 *
 * Faithful in-app translation of Quinn's original BMAD agent menu
 * (memoir-writing-coach). Two kinds of commands:
 *
 *  - Workflows: multi-step, step-gated procedures (Review Essay / editorial-pass,
 *    Plan Collection / essay-triage). Quinn does one step, then the writer
 *    advances with /next.
 *  - Prompt commands: single-shot "modes" that inject a one-turn instruction
 *    (Analyze Writing, Central Question Check, Coach Session, Progress, Check-in).
 *
 * Everything is data and migration-free: workflow state is persisted as a
 * system-message marker in the `messages` table (see coaching.service.ts).
 *
 * Original menu mapping:
 *   [RE] Review Essay     -> /editorial-pass   (workflow)
 *   [PC] Plan Collection  -> /essay-triage     (workflow)
 *   [AN] Analyze Writing  -> /analyze          (prompt)
 *   [CQ] Central Question -> /central-question (prompt)
 *   [CS] Coach Session    -> /coach            (prompt)
 *   [PR] Progress Report  -> /progress         (prompt)
 *   [DC] Daily Check-in   -> /checkin          (prompt)
 */

export interface WorkflowStep {
  id: string;
  title: string;
  instruction: string;
}

export interface CoachingWorkflow {
  /** Stable id, also the primary slash command (e.g. /essay-triage). */
  id: string;
  /** Alternate triggers, incl. the original BMAD 2-letter codes. */
  aliases?: string[];
  label: string;
  description: string;
  /** Project types this applies to (matches projects.project_type). */
  projectTypes?: string[];
  /** Whether it operates on a single named piece (forces full text). */
  targetsSinglePiece?: boolean;
  /** Prefer Opus for this workflow when model routing is on auto. */
  preferOpus?: boolean;
  intro: string;
  steps: WorkflowStep[];
}

export interface PromptCommand {
  /** Stable id, also the primary slash command (e.g. /analyze). */
  id: string;
  aliases?: string[];
  label: string;
  description: string;
  projectTypes?: string[];
  /** Whether it operates on a single named piece (forces full text). */
  targetsSinglePiece?: boolean;
  /** Prefer Opus for this mode when model routing is on auto. */
  preferOpus?: boolean;
  /** One-turn instruction injected into the system prompt for the response. */
  instruction: string;
}

// ─── Workflows ───────────────────────────────────────────────────────────────

const ESSAY_TRIAGE: CoachingWorkflow = {
  id: 'essay-triage',
  aliases: ['pc', 'plan', 'plan-collection'],
  label: 'Essay Triage / Plan Collection',
  description:
    'Sort the collection against its central question — keep / cut / merge / revisit — then decide the "right number" and sequence the keepers (Muriel as capstone).',
  projectTypes: ['essay_collection'],
  preferOpus: true,
  intro:
    "We'll triage the collection against your central question, cluster by cluster, then shape what stays into a book. I flag and reason; every call is yours. /next to advance, /exit to stop.",
  steps: [
    {
      id: 'survey',
      title: 'Survey the collection',
      instruction:
        "STEP 1 of 4 — SURVEY. Using the manuscript map and per-piece loglines, give the writer a clear lay of the land: how many pieces, how they're grouped (the parts/folders), and your first-pass read of which clearly serve the central question, which are uncertain, which feel like outliers or salvage. Note any hidden gems they may undervalue and any stories told more than once from different angles. Do NOT make final cut calls yet. End by asking which part or cluster to triage first. Do only this step.",
    },
    {
      id: 'assess-cluster',
      title: 'Assess the chosen cluster',
      instruction:
        "STEP 2 of 4 — ASSESS A CLUSTER. For the cluster the writer chose, go piece by piece. For each: one line on what it's doing, one line on how it serves the central question, the Lilo-First Filter (\"Will this matter to Lilo?\"), and a provisional call — KEEP / CUT / MERGE / REVISIT — always as a flag with reasoning, never a command. Invite pushback on each. Work ONLY this cluster; when done, ask whether to triage another cluster or consolidate (/next). Do only this step.",
    },
    {
      id: 'decisions',
      title: 'Consolidate decisions & the right number',
      instruction:
        "STEP 3 of 4 — DECISION LOG. Consolidate the calls into a log grouped by KEEP, CUT, MERGE, REVISIT, each with a one-line rationale. Then open the question of the \"right number\" of essays for a collection that serves the central question without padding. Be honest about what's unresolved; list open questions. Ask the writer to confirm or adjust before sequencing. Do only this step.",
    },
    {
      id: 'sequence',
      title: 'Sequence & frame',
      instruction:
        "STEP 4 of 4 — SEQUENCE & FRAME. For the KEEP pile, propose an order/arc that serves the central question: how pieces speak to one another, where the Muriel capstone lands, what opens and closes the collection, and how an introduction might frame the central question up front. Offer one or two alternative orderings with reasoning. Flags and options, not commands. Close by offering to save this as session notes.",
    },
  ],
};

const EDITORIAL_PASS: CoachingWorkflow = {
  id: 'editorial-pass',
  aliases: ['re', 'review', 'review-essay'],
  label: 'Editorial Pass / Review Essay',
  description:
    "A close, flag-don't-cut editorial read of one piece — orient, structural flags, line-level flags, then a prioritized revision plan.",
  targetsSinglePiece: true,
  preferOpus: true,
  intro:
    "We'll do a close editorial read of one piece — I flag and reason, I never rewrite. Name the piece if you haven't (e.g. /editorial-pass Fenway). /next to advance, /exit to stop.",
  steps: [
    {
      id: 'orient',
      title: 'Orient on the piece',
      instruction:
        "STEP 1 of 4 — ORIENT. Confirm which piece you're working on; it should be loaded as FULL TEXT in the corpus context. If no piece is loaded in full, ask the writer to name it and stop there. Otherwise read it completely to understand the writer's intent, then reflect back what the piece is doing — its central move, its tension, its tone — so they know you read every word. Ask what they want from this pass: a specific worry, or a general read. Do only this step.",
    },
    {
      id: 'structure',
      title: 'Structural flags',
      instruction:
        "STEP 2 of 4 — STRUCTURE (flag, don't cut). Work the piece at the structural level. FLAG excess — logistics and over-explanations that don't serve meaning. FLAG preachiness — \"I learned that...\" moments. FLAG tidy endings — suggest trusting ambiguity instead. FLAG where the writer explains rather than trusts the reader (show vs. tell). Tie observations to the central question where relevant. Numbered flags with location cues and reasoning; the writer decides. Do only this step.",
    },
    {
      id: 'line',
      title: 'Line-level flags & voice',
      instruction:
        "STEP 3 of 4 — LINE LEVEL. Surface specific sentences or passages worth reconsidering — overwriting, cliché, a joke that undercuts emotional truth, sentimentality that slipped past, a flat verb. Quote the line, name the issue, leave the fix to the writer. Run a Preserve-Voice check: actively protect the self-deprecation, dark humor, and earned ambiguity that make this their voice. Do only this step.",
    },
    {
      id: 'synthesis',
      title: 'Revision plan',
      instruction:
        "STEP 4 of 4 — SYNTHESIS. Summarize: what's working and must be protected; any restructuring worth considering (preserving voice); then the top 3-5 flags in priority order with concrete next revision steps the writer can act on. Offer to save this as session notes. Do only this step.",
    },
  ],
};

export const WORKFLOWS: CoachingWorkflow[] = [ESSAY_TRIAGE, EDITORIAL_PASS];

// ─── Prompt commands (single-shot modes) ─────────────────────────────────────

const CENTRAL_QUESTION = "What does it take to live a good life?";

const PROMPT_COMMANDS: PromptCommand[] = [
  {
    id: 'analyze',
    aliases: ['an', 'analyze-writing'],
    label: 'Analyze Writing',
    description: 'Find connections, patterns, and themes across the corpus.',
    preferOpus: true,
    instruction:
      `Perform a deep analysis of the writer's corpus using the manuscript map and per-piece loglines (and any full texts loaded). Find connections across years of writing; identify patterns in themes, voice, and recurring topics; map the work to the central question ("${CENTRAL_QUESTION}"); uncover hidden gems the writer may undervalue; spot stories told more than once from different angles; and note how the voice has evolved. Be specific — cite pieces by name. Offer this as observations to explore together, not verdicts.`,
  },
  {
    id: 'central-question',
    aliases: ['cq', 'central'],
    label: 'Central Question Check',
    description: 'Does a given essay serve the central question? Name the piece.',
    targetsSinglePiece: true,
    preferOpus: true,
    instruction:
      `Assess whether the named piece serves the central question ("${CENTRAL_QUESTION}"). Be honest, specific, and compassionate: what in the piece speaks to the question, what doesn't, and whether it earns its place. If it doesn't serve the question directly, consider whether it serves the collection another way. Flags and reasoning; the writer decides.`,
  },
  {
    id: 'coach',
    aliases: ['cs', 'coach-session'],
    label: 'Coach Session',
    description: 'Open partnership dialogue about any writing challenge.',
    instruction:
      `Open a partnership dialogue about whatever the writer raises. Lead with questions over answers — draw out the insight they haven't articulated yet, get their drift, and ask what they actually like about the work before any critique. Remove shame from being stuck or uncertain. Strong, humble opinions are welcome, but invite them to push back. Partnership, not hierarchy — they have final authority.`,
  },
  {
    id: 'progress',
    aliases: ['pr', 'progress-report'],
    label: 'Progress Report',
    description: 'Where the collection stands, roadblocks, and what matters most next.',
    instruction:
      `Give a grounded progress report on the collection: where things stand now (use the manuscript map and recent activity), what's working, what the roadblocks are, and what matters most to do next. Gentle urgency, celebrate real milestones, no panic. End with a small, realistic next focus.`,
  },
  {
    id: 'checkin',
    aliases: ['dc', 'check-in', 'daily-checkin'],
    label: 'Check-in',
    description: 'Reflect on this session and set the next focus.',
    instruction:
      `Run a reflective check-in: what did we accomplish this session, what surfaced worth remembering, and what's the focus next time? Gentle accountability, celebrate progress, keep the next step realistic.`,
  },
];

// ─── Lookups ─────────────────────────────────────────────────────────────────

/** Look up a workflow by id or alias. */
export function getWorkflow(idOrAlias: string): CoachingWorkflow | undefined {
  const key = idOrAlias.toLowerCase();
  return WORKFLOWS.find((w) => w.id === key || (w.aliases ?? []).includes(key));
}

/** Look up a prompt command by id or alias. */
export function getPromptCommand(idOrAlias: string): PromptCommand | undefined {
  const key = idOrAlias.toLowerCase();
  return PROMPT_COMMANDS.find((c) => c.id === key || (c.aliases ?? []).includes(key));
}

/** Workflows available for a given project type (null = unknown → show all). */
export function workflowsForProjectType(projectType: string | null): CoachingWorkflow[] {
  if (!projectType) return WORKFLOWS;
  return WORKFLOWS.filter((w) => !w.projectTypes || w.projectTypes.includes(projectType));
}

/** Prompt commands available for a given project type. */
export function promptCommandsForProjectType(projectType: string | null): PromptCommand[] {
  if (!projectType) return PROMPT_COMMANDS;
  return PROMPT_COMMANDS.filter((c) => !c.projectTypes || c.projectTypes.includes(projectType));
}

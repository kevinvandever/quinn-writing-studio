/**
 * Coaching Workflows
 *
 * BMAD-style structured procedures Quinn can run inside a coaching session.
 * A workflow is data: an ordered list of steps, each with an instruction that
 * gets injected into the system prompt as "the one thing to do right now". This
 * is what turns free-form chat into a methodical, step-gated process — Quinn
 * does the current step, then the writer advances with /next.
 *
 * Workflows are migration-free: the active workflow + step index is persisted
 * as a system-message marker in the existing `messages` table (see
 * coaching.service.ts), so adding/editing workflows needs no schema change.
 */

export interface WorkflowStep {
  /** Stable id for the step (for state/debugging). */
  id: string;
  /** Short human title shown in /help and progress lines. */
  title: string;
  /** Instruction injected into the system prompt while this step is active. */
  instruction: string;
}

export interface CoachingWorkflow {
  /** Stable id, also the slash command (e.g. "essay-triage" → /essay-triage). */
  id: string;
  /** Human label. */
  label: string;
  /** One-line description for the /help menu. */
  description: string;
  /**
   * Project types this workflow applies to (matches projects.project_type).
   * Omit to make it available for any project.
   */
  projectTypes?: string[];
  /** Whether the workflow operates on a single named piece (e.g. editorial). */
  targetsSinglePiece?: boolean;
  /** Shown when the workflow starts, before the first step. */
  intro: string;
  steps: WorkflowStep[];
}

const ESSAY_TRIAGE: CoachingWorkflow = {
  id: 'essay-triage',
  label: 'Essay Triage',
  description:
    'Sort the collection against its central question — keep / cut / merge / revisit — cluster by cluster, then sequence the keepers.',
  projectTypes: ['essay_collection'],
  intro:
    "We'll triage the collection against your central question, one cluster at a time, then sequence what stays. I'll flag and reason; every call is yours. Use /next to advance, /exit to stop.",
  steps: [
    {
      id: 'survey',
      title: 'Survey the collection',
      instruction:
        "STEP 1 of 4 — SURVEY. Using the manuscript map and the per-piece loglines, give the writer a clear lay of the land: how many pieces there are, how they're grouped (the parts/folders), and your first-pass read of which pieces clearly serve the central question, which are uncertain, and which feel like outliers or salvage. Do NOT make final keep/cut calls yet — this is reconnaissance. Keep it scannable. End by asking which part or cluster they want to triage first. Do only this step.",
    },
    {
      id: 'assess-cluster',
      title: 'Assess the chosen cluster',
      instruction:
        "STEP 2 of 4 — ASSESS A CLUSTER. For the cluster the writer chose, go piece by piece. For each piece: one line on what it's doing, one line on how it serves (or doesn't serve) the central question, and a provisional call — KEEP / CUT / MERGE / REVISIT — always framed as a flag with reasoning, never a command. Invite the writer to push back on each. Work ONLY this cluster. When the cluster is done, ask whether to triage another cluster (stay on this step) or move to consolidating decisions (/next). Do only this step.",
    },
    {
      id: 'decisions',
      title: 'Consolidate decisions',
      instruction:
        "STEP 3 of 4 — DECISION LOG. Consolidate the calls made so far into a clear log grouped by KEEP, CUT, MERGE, REVISIT, each with a one-line rationale. Be honest about what's still unresolved and list the open questions. Ask the writer to confirm or adjust before sequencing. Do only this step.",
    },
    {
      id: 'sequence',
      title: 'Sequence the keepers',
      instruction:
        "STEP 4 of 4 — SEQUENCE. For the KEEP pile, propose an order/arc that serves the central question: how pieces speak to one another, where the capstone lands, what opens and closes the collection. Offer one or two alternative orderings with the reasoning for each. Flags and options, not commands. Close by offering to save this as session notes.",
    },
  ],
};

const EDITORIAL_PASS: CoachingWorkflow = {
  id: 'editorial-pass',
  label: 'Editorial Pass',
  description:
    'A close, flag-don\'t-cut editorial read of a single piece — structure, then line level, then a prioritized revision plan.',
  targetsSinglePiece: true,
  intro:
    "We'll do a close editorial read of one piece — structure first, then line level, then a prioritized revision plan. I flag and reason; I never rewrite. Name the piece if you haven't (e.g. /editorial-pass Fenway). Use /next to advance, /exit to stop.",
  steps: [
    {
      id: 'orient',
      title: 'Orient on the piece',
      instruction:
        "STEP 1 of 4 — ORIENT. Confirm which piece you're working on; it should be loaded as FULL TEXT in the corpus context. If no piece is loaded in full, ask the writer to name it and stop there. Otherwise read it closely and reflect back what the piece is actually doing — its central move, its tension, its tone — so the writer knows you read every word. Then ask what they want from this pass: a specific worry, or a general read. Do only this step.",
    },
    {
      id: 'structure',
      title: 'Structural flags',
      instruction:
        "STEP 2 of 4 — STRUCTURE. Work the piece at the structural level: opening, escalation, ending. Flag (do NOT rewrite) tidy/over-resolved endings, preachiness, places it tells rather than shows, sections that don't earn their keep, pacing problems. Tie observations to the central question where relevant. Present as numbered flags with location cues and reasoning. Do only this step.",
    },
    {
      id: 'line',
      title: 'Line-level flags',
      instruction:
        "STEP 3 of 4 — LINE LEVEL. Surface specific sentences or passages worth reconsidering — overwriting, cliché, a joke that undercuts emotional truth, sentimentality that slipped past, a flat verb. Quote the line, name the issue, and leave the fix to the writer. Actively protect the writer's voice: self-deprecation, dark humor, earned ambiguity. Do only this step.",
    },
    {
      id: 'synthesis',
      title: 'Revision plan',
      instruction:
        "STEP 4 of 4 — SYNTHESIS. Summarize: what's working and must be protected, then the top 3-5 flags in priority order, then concrete next revision steps the writer can act on. Offer to save this as session notes. Do only this step.",
    },
  ],
};

export const WORKFLOWS: CoachingWorkflow[] = [ESSAY_TRIAGE, EDITORIAL_PASS];

/** Look up a workflow by id (slash command). */
export function getWorkflow(id: string): CoachingWorkflow | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}

/** Workflows available for a given project type (null = unknown → show all). */
export function workflowsForProjectType(projectType: string | null): CoachingWorkflow[] {
  if (!projectType) return WORKFLOWS;
  return WORKFLOWS.filter((w) => !w.projectTypes || w.projectTypes.includes(projectType));
}

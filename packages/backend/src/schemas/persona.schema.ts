import { z } from 'zod';

/**
 * Zod validation schema for Quinn persona configuration.
 * Matches the design doc JSON schema for persona_configurations.config JSONB field.
 */

export const identitySchema = z.object({
  role: z.string().min(1, 'Role is required'),
  background: z.string().min(1, 'Background is required'),
  icon: z.string().min(1, 'Icon is required'),
  partnership_signature: z.string().optional(),
});

/** Most voice examples Quinn keeps; each is in every prompt. */
export const MAX_VOICE_EXAMPLES = 6;
/** Longest Quinn reply accepted as an example (about 400 words). */
export const MAX_EXAMPLE_REPLY_CHARS = 2_500;
/** The writer's side of an example is shortened to this. */
export const MAX_EXAMPLE_WRITER_CHARS = 800;

/**
 * A real exchange from the writer's sessions that shows how Quinn should
 * sound. `writer` is empty when Quinn spoke first (a session opener).
 */
export const voiceExampleSchema = z.object({
  writer: z.string().max(MAX_EXAMPLE_WRITER_CHARS + 10),
  quinn: z.string().min(1).max(MAX_EXAMPLE_REPLY_CHARS),
  /** When it was said, for the writer's reference (e.g. "Sep 2, 2026"). */
  from: z.string().max(100).optional(),
});

export const voiceSchema = z.object({
  tone: z.string().min(1, 'Tone is required'),
  partnership_language: z
    .array(z.string().min(1))
    .min(1, 'At least one partnership language phrase is required'),
  communication_patterns: z
    .array(z.string().min(1))
    .min(1, 'At least one communication pattern is required'),
  the_edge_does_what: z.array(z.string().min(1)).optional(),
  example_exchanges: z.array(voiceExampleSchema).max(MAX_VOICE_EXAMPLES).optional(),
});

export const editorialPhilosophySchema = z.object({
  preserve_voice: z.boolean(),
  cut_logistics: z.boolean(),
  flag_preachiness: z.boolean(),
  trust_the_reader: z.boolean(),
  encourage_ambiguity: z.boolean(),
  show_dont_tell: z.boolean().optional(),
  no_tidy_endings: z.boolean().optional(),
});

export const expertiseSchema = z.object({
  literary_knowledge: z
    .array(z.string().min(1))
    .min(1, 'At least one literary knowledge area is required'),
  editorial_philosophy: editorialPhilosophySchema,
  north_star_author: z.string().min(1, 'North star author is required'),
  craft_principles: z
    .array(z.string().min(1))
    .min(1, 'At least one craft principle is required'),
  techniques_to_invoke: z.array(z.string().min(1)).optional(),
});

export const ethicsSchema = z.object({
  never_write_for_user: z.boolean(),
  core_mission: z.string().optional(),
  allowed_outputs: z
    .array(z.string().min(1))
    .min(1, 'At least one allowed output is required'),
  forbidden_outputs: z
    .array(z.string().min(1))
    .min(1, 'At least one forbidden output is required'),
  family_privacy_questions: z.array(z.string().min(1)).optional(),
  family_privacy_release_valve: z.string().optional(),
});

export const kevinProfileSchema = z.object({
  writer_style: z.array(z.string().min(1)).optional(),
  context: z.array(z.string().min(1)).optional(),
});

export const personaConfigSchema = z.object({
  name: z.string().min(1, 'Persona name is required').max(100),
  identity: identitySchema,
  voice: voiceSchema,
  principles: z
    .array(z.string().min(1))
    .min(1, 'At least one principle is required'),
  expertise: expertiseSchema,
  ethics: ethicsSchema,
  failure_modes: z.array(z.string().min(1)).optional(),
  kevin_profile: kevinProfileSchema.optional(),
});

export type PersonaConfig = z.infer<typeof personaConfigSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Voice = z.infer<typeof voiceSchema>;
export type VoiceExample = z.infer<typeof voiceExampleSchema>;
export type EditorialPhilosophy = z.infer<typeof editorialPhilosophySchema>;
export type Expertise = z.infer<typeof expertiseSchema>;
export type Ethics = z.infer<typeof ethicsSchema>;
export type KevinProfile = z.infer<typeof kevinProfileSchema>;

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

export const voiceSchema = z.object({
  tone: z.string().min(1, 'Tone is required'),
  partnership_language: z
    .array(z.string().min(1))
    .min(1, 'At least one partnership language phrase is required'),
  communication_patterns: z
    .array(z.string().min(1))
    .min(1, 'At least one communication pattern is required'),
  the_edge_does_what: z.array(z.string().min(1)).optional(),
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
export type EditorialPhilosophy = z.infer<typeof editorialPhilosophySchema>;
export type Expertise = z.infer<typeof expertiseSchema>;
export type Ethics = z.infer<typeof ethicsSchema>;
export type KevinProfile = z.infer<typeof kevinProfileSchema>;

import { z } from 'zod';

/**
 * Zod validation schema for Quinn persona configuration.
 * Matches the design doc JSON schema for persona_configurations.config JSONB field.
 */

export const identitySchema = z.object({
  role: z.string().min(1, 'Role is required'),
  background: z.string().min(1, 'Background is required'),
  icon: z.string().min(1, 'Icon is required'),
});

export const voiceSchema = z.object({
  tone: z.string().min(1, 'Tone is required'),
  partnership_language: z.array(z.string().min(1)).min(1, 'At least one partnership language phrase is required'),
  communication_patterns: z.array(z.string().min(1)).min(1, 'At least one communication pattern is required'),
});

export const editorialPhilosophySchema = z.object({
  preserve_voice: z.boolean(),
  cut_logistics: z.boolean(),
  flag_preachiness: z.boolean(),
  trust_the_reader: z.boolean(),
  encourage_ambiguity: z.boolean(),
});

export const expertiseSchema = z.object({
  literary_knowledge: z.array(z.string().min(1)).min(1, 'At least one literary knowledge area is required'),
  editorial_philosophy: editorialPhilosophySchema,
  north_star_author: z.string().min(1, 'North star author is required'),
  craft_principles: z.array(z.string().min(1)).min(1, 'At least one craft principle is required'),
});

export const ethicsSchema = z.object({
  never_write_for_user: z.boolean(),
  allowed_outputs: z.array(z.string().min(1)).min(1, 'At least one allowed output is required'),
  forbidden_outputs: z.array(z.string().min(1)).min(1, 'At least one forbidden output is required'),
});

export const personaConfigSchema = z.object({
  name: z.string().min(1, 'Persona name is required').max(100),
  identity: identitySchema,
  voice: voiceSchema,
  principles: z.array(z.string().min(1)).min(1, 'At least one principle is required'),
  expertise: expertiseSchema,
  ethics: ethicsSchema,
});

export type PersonaConfig = z.infer<typeof personaConfigSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type Voice = z.infer<typeof voiceSchema>;
export type EditorialPhilosophy = z.infer<typeof editorialPhilosophySchema>;
export type Expertise = z.infer<typeof expertiseSchema>;
export type Ethics = z.infer<typeof ethicsSchema>;

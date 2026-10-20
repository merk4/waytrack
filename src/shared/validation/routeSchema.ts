import { z } from 'zod';
import { ACCESS_LEVELS, ENVIRONMENTS, ROAD_CLASSES, SIDEWALKS, TURN_KINDS } from '../../domain/route/types.ts';

export const lngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const spanSchema = <T extends z.ZodType>(value: T) =>
  z
    .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), value })
    .refine((s) => s.to >= s.from, { message: 'span.to must be >= span.from' });

export const routeAttributesSchema = z.object({
  roadClass: z.array(spanSchema(z.enum(ROAD_CLASSES))).optional(),
  access: z.array(spanSchema(z.enum(ACCESS_LEVELS))).optional(),
  streetName: z.array(spanSchema(z.string())).optional(),
  sidewalk: z.array(spanSchema(z.enum(SIDEWALKS))).optional(),
  lanes: z.array(spanSchema(z.number().int().nonnegative().nullable())).optional(),
  maxSpeed: z.array(spanSchema(z.number().nonnegative().nullable())).optional(),
  environment: z.array(spanSchema(z.enum(ENVIRONMENTS))).optional(),
});

export const generationPreferencesSchema = z
  .object({
    terrain: z.enum(['flat', 'any', 'hilly']),
    targetGainM: z.number().positive().max(5000).optional(),
    avoidBusyRoads: z.boolean(),
    preferPavements: z.boolean(),
    avoidLaps: z.boolean().optional(),
  })
  .refine((p) => p.terrain !== 'hilly' || p.targetGainM !== undefined, { message: 'targetGainM is required for hilly terrain', path: ['targetGainM'] });

export const instructionSchema = z
  .object({
    turn: z.enum(TURN_KINDS),
    text: z.string(),
    streetName: z.string(),
    distanceM: z.number().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .refine((i) => i.to >= i.from, { message: 'instruction.to must be >= from' });

export const waypointSchema = z.object({ position: lngLatSchema, geometryIndex: z.number().int().nonnegative() });

export const routeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  geometry: z.array(lngLatSchema).min(2),
  waypoints: z.array(waypointSchema),
  attributes: routeAttributesSchema,
  instructions: z.array(instructionSchema).optional(),
  source: z.object({
    kind: z.enum(['manual', 'generated', 'import', 'fixture']),
    provider: z.string().optional(),
    profile: z.string().optional(),
  }),
  generation: z
    .object({
      preferences: generationPreferencesSchema,
      targetDistanceM: z.number().positive(),
      seed: z.number().int(),
      candidateSource: z.string(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

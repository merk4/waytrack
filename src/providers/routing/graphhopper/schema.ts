import { z } from 'zod';

// Shapes verified against live responses captured in test/fixtures/providers/graphhopper-*.json.

const position = z.tuple([z.number(), z.number()]).rest(z.number());
const detail = <T extends z.ZodType>(value: T) => z.array(z.tuple([z.number().int(), z.number().int(), value]));

export const ghPathSchema = z.object({
  distance: z.number(),
  points: z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
  snapped_waypoints: z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(1) }),
  instructions: z.array(
    z.object({
      distance: z.number(),
      sign: z.number().int(),
      interval: z.tuple([z.number().int(), z.number().int()]),
      text: z.string(),
      street_name: z.string().default(''),
    }),
  ),
  details: z.object({
    road_class: detail(z.string()),
    foot_access: detail(z.boolean()),
    // Recorded live: unnamed ways come back as null.
    street_name: detail(z.string().nullable()).optional(),
    sidewalk: detail(z.string().nullable()).optional(),
    lanes: detail(z.number().nullable()).optional(),
    max_speed: detail(z.number().nullable()).optional(),
    road_environment: detail(z.string().nullable()).optional(),
  }),
});

export const ghRouteResponseSchema = z.object({
  info: z.object({ road_data_timestamp: z.string().optional() }).optional(),
  paths: z.array(ghPathSchema).min(1),
});

export const ghErrorSchema = z.object({
  message: z.string(),
  hints: z
    .array(z.object({ message: z.string(), details: z.string().optional(), point_index: z.number().int().optional() }))
    .optional(),
});

export type GhPath = z.infer<typeof ghPathSchema>;

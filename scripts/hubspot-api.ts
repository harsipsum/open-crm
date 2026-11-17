import { z } from "zod";
export const sourceRecordSchema = z
  .object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    properties: z.record(z.string(), z.string().nullable()).optional(),
    archived: z.boolean().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
const paging = z
  .object({ next: z.object({ after: z.coerce.string() }).optional() })
  .optional();
export const hubspotAnswer = z.object({
  results: z.array(z.unknown()).default([]),
  total: z.number().optional(),
  status: z.string().optional(),
  paging,
  errors: z
    .array(z.object({ subCategory: z.string().optional() }).passthrough())
    .optional(),
});
export const propertySchema = z.object({ name: z.string() }).passthrough();
export const pipelineSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    stages: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          displayOrder: z.number(),
          metadata: z
            .object({
              isClosed: z.coerce.string().optional(),
              probability: z.coerce.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export const associationTargetSchema = z.object({
  toObjectId: z.coerce.string(),
  associationTypes: z.array(
    z.object({
      typeId: z.number(),
      category: z.string(),
      label: z.string().nullable().optional(),
    }),
  ),
});
export type AssociationTarget = z.infer<typeof associationTargetSchema>;
export const associationRowSchema = z.object({
  from: z.object({ id: z.string() }),
  to: z.array(associationTargetSchema),
  paging,
});
export const crmAnswer = z.object({
  asanaEnabled: z.boolean().optional(),
  received: z.number().optional(),
  created: z.number().optional(),
  objects: z
    .array(
      z.object({
        objectType: z.string(),
        count: z.number(),
        active: z.number(),
      }),
    )
    .default([]),
  projections: z.record(z.string(), z.number()).default({}),
  associations: z.number().optional(),
});

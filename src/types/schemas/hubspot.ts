import { z } from "zod";

const hubspotTypes = [
  "owners",
  "pipelines",
  "stages",
  "companies",
  "contacts",
  "deals",
  "notes",
  "schemas",
] as const;
const source = z
  .object({
    id: z.string().min(1).max(200),
    properties: z.record(z.string(), z.string().nullable()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    archived: z.boolean().optional(),
  })
  .catchall(z.unknown());
export const hubspotBatchSchema = z.object({
  portalId: z.string().regex(/^\d{1,20}$/),
  objectType: z.enum(hubspotTypes),
  records: z.array(source).max(25),
});
export type HubspotBatch = z.infer<typeof hubspotBatchSchema>;

export const hubspotAssociationsSchema = z.object({
  portalId: z.string().regex(/^\d{1,20}$/),
  records: z
    .array(
      z.object({
        fromType: z.enum(["companies", "contacts", "deals", "notes"]),
        fromId: z.string().min(1).max(200),
        toType: z.enum(["companies", "contacts", "deals", "notes"]),
        toId: z.string().min(1).max(200),
        typeId: z.string().min(1).max(100),
        category: z.string().min(1).max(100),
        label: z.string().max(1000).nullable(),
      }),
    )
    .max(100),
});
export type HubspotAssociations = z.infer<typeof hubspotAssociationsSchema>;

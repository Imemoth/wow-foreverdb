import { z } from "../zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a calendar date");
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const propValue = z.union([scalar, z.array(scalar)]);
const props = z.record(z.string().min(1), propValue);
const evidence = z.enum(["client-verified", "official", "corroborated", "unverified"]);
const id = z.string().regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/);

export const SourceRefSchema = z
  .object({
    id,
    url: z.url().refine((u) => u.startsWith("https://"), "sources must be https"),
    title: z.string().min(3).max(200),
    publisher: z.string().min(2).max(80),
    kind: z.enum(["client-data", "official-dev-notes", "official-article", "community"]),
    publishedOn: isoDate,
    retrievedOn: isoDate,
  })
  .strict();

export const SourceCatalogSchema = z
  .object({
    schema: z.literal("azerdex.versioned-sources/1"),
    sources: z.array(SourceRefSchema).min(1).superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((s, i) => {
        if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate source id ${s.id}`, path: [i, "id"] });
        seen.add(s.id);
      });
    }),
  })
  .strict();

export const BaselineSchema = z
  .object({
    schema: z.literal("azerdex.versioned-baseline/1"),
    asOf: isoDate,
    title: z.string().min(3).max(200),
    entities: z
      .array(z.object({ id, kind: z.string().min(1), evidence, propEvidence: z.record(z.string().min(1), evidence).optional(), props, sources: z.array(id).min(1) }).strict())
      .min(1),
  })
  .strict();

const op = z
  .object({
    entity: id,
    type: z.enum(["added", "modified", "renamed", "removed", "restored", "documented"]),
    kind: z.string().min(1).optional(),
    set: props.optional(),
    previous: props.optional(),
    summary: z.string().min(8).max(300),
  })
  .strict();

export const ChangeFileSchema = z
  .object({
    schema: z.literal("azerdex.versioned-changes/1"),
    title: z.string().min(3).max(200),
    records: z
      .array(
        z
          .object({
            id,
            announcedOn: isoDate,
            effectiveOn: isoDate.nullable(),
            build: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/).nullable(),
            evidence,
            sources: z.array(id).min(1),
            verifiedOn: isoDate,
            notes: z.string().max(600).optional(),
            ops: z.array(op).min(1),
          })
          .strict()
          .refine((r) => r.build === null || r.evidence === "client-verified", { message: "a build may only be attached to client-verified records", path: ["build"] }),
      )
      .min(1),
  })
  .strict();

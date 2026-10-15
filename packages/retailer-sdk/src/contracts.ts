import { z } from "zod";
export const productRefSchema = z.object({
  productId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).optional(),
});
export const observationSchema = z.object({
  eventId: z.string().min(1),
  streamId: z.string().min(1),
  retailerId: z.string().min(1),
  product: productRefSchema,
  sequence: z.number().int().nonnegative(),
  observedAt: z.number().finite(),
  expiresAt: z.number().finite().optional(),
  availability: z.enum(["in-stock", "out-of-stock", "unknown"]),
  quantity: z.number().nonnegative().optional(),
  details: z.lazy(() => observationDetailsSchema).optional(),
});
export const orderStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    authoritative: z.literal(true),
    idempotencyKey: z.string().min(1),
    sourceId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    checkedAt: z.number().finite(),
    orderId: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    authoritative: z.literal(true),
    idempotencyKey: z.string().min(1),
    sourceId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    checkedAt: z.number().finite(),
    reason: z.string().min(1),
  }),
  z.object({
    status: z.enum(["pending", "unresolved"]),
    authoritative: z.literal(false),
    idempotencyKey: z.string().min(1),
    sourceId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    checkedAt: z.number().finite(),
    reason: z.string().optional(),
  }),
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export const imageSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "HTTPS image required"),
    alt: z.string().max(500).nullable(),
  })
  .strict();
export const attributesSchema = z
  .array(
    z
      .object({ name: z.string().max(200), value: z.string().max(500) })
      .strict(),
  )
  .max(100);
export const productDetailsSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().max(500),
    handle: z.string().max(200).optional(),
    description: z.string().max(10000).optional(),
    image: imageSchema.nullable().optional(),
    observedAt: z.number().finite().optional(),
    variantsComplete: z.boolean().optional(),
    available: z.boolean().optional(),
    variants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            title: z.string().max(500),
            available: z.boolean(),
            attributes: attributesSchema.optional(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export type ProductDetails = z.infer<typeof productDetailsSchema>;
export const productPageSchema = z
  .object({
    products: z.array(productDetailsSchema).max(50),
    nextCursor: z.string().max(2000).nullable(),
  })
  .strict();
export type ProductPage = z.infer<typeof productPageSchema>;
export const observationDetailsSchema = productDetailsSchema
  .pick({ title: true, description: true, image: true })
  .extend({
    variantTitle: z.string().max(500).optional(),
    attributes: attributesSchema.optional(),
  })
  .strict();
export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "select" | "checkbox";
  defaultValue?: string | boolean;
  options?: { value: string; label: string }[];
}

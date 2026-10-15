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
export interface ProductDetails {
  id: string;
  title: string;
  variants: { id: string; title: string; available: boolean }[];
}
export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "select" | "checkbox";
  defaultValue?: string | boolean;
  options?: { value: string; label: string }[];
}

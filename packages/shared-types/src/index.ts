import { z } from "zod";
export const states = [
  "CREATED",
  "MONITORING",
  "STOCK_DETECTED",
  "CARTING",
  "AWAITING_APPROVAL",
  "CHECKING_OUT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN_OUTCOME",
] as const;
export type TaskState = (typeof states)[number];
const name = z.string().trim().min(1).max(120);
const id = z.string().uuid();
export const groupSchema = z
  .object({
    id: id.optional(),
    name,
    retailer: z.string().regex(/^[a-z0-9-]{1,60}$/),
  })
  .strict();
export const scenarios = [
  "available",
  "out-of-stock",
  "timeout",
  "rate-limit",
  "checkout-failure",
] as const;
export const taskSchema = z
  .object({
    id: id.optional(),
    groupId: id,
    name,
    product: name,
    variantId: z.string().trim().min(1).max(120).nullable().default(null),
    profileId: id.nullable().default(null),
    proxyId: id.nullable().default(null),
    scenario: z.enum(scenarios),
    intervalMs: z.number().int().min(100).max(60000),
    maxRetries: z.number().int().min(0).max(5),
  })
  .strict();
export const profileSchema = z
  .object({
    id: id.optional(),
    name,
    group: name,
    email: z.email(),
    phone: z.string().max(40),
    address: z.string().max(200),
    city: z.string().max(80),
    postalCode: z.string().max(30),
    country: z
      .string()
      .regex(/^[a-zA-Z]{2}$/, "Use a two-letter country code")
      .transform((value) => value.toUpperCase()),
    paymentToken: z
      .string()
      .regex(/^mock_[a-zA-Z0-9_-]{1,64}$/, "Use a mock_ placeholder token"),
  })
  .strict();
export const proxySchema = z
  .object({
    id: id.optional(),
    name,
    group: name,
    protocol: z.enum(["http", "socks5"]),
    host: z
      .string()
      .max(253)
      .refine(
        validProxyHost,
        "Enter a hostname or IP address without credentials",
      ),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
function validProxyHost(host: string): boolean {
  if (host.startsWith("[")) {
    try {
      return host.endsWith("]") && new URL(`http://${host}`).hostname === host;
    } catch {
      return false;
    }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
    return host
      .split(".")
      .every((part) => Number(part) <= 255 && part.length <= 3);
  return host
    .split(".")
    .every((part) =>
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part),
    );
}
export const settingsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(20),
    resumeMonitoring: z.boolean().default(false),
    notifications: z.boolean(),
    logLevel: z.enum(["info", "debug"]),
    launchView: z.enum([
      "Dashboard",
      "Tasks",
      "Profiles",
      "Proxies",
      "Settings",
    ]),
  })
  .strict();
export type Group = Required<z.infer<typeof groupSchema>>;
export type TaskInput = z.infer<typeof taskSchema>;
export type Task = Required<TaskInput> & {
  state: TaskState;
  runId: string | null;
  updatedAt: string;
};
export type Profile = Required<z.infer<typeof profileSchema>>;
export type Proxy = Required<z.infer<typeof proxySchema>>;
export type Settings = z.infer<typeof settingsSchema>;
export interface Log {
  id: string;
  taskId: string;
  runId: string | null;
  at: string;
  level: "info" | "error";
  message: string;
  state: TaskState;
}
export interface Run {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: TaskState;
  recovery?:
    | "interrupted-monitoring"
    | "approval-restored"
    | "checkout-unknown"
    | "interrupted-operation";
}
export interface Snapshot {
  revision: number;
  retailers: { id: string; name: string }[];
  groups: Group[];
  tasks: Task[];
  profiles: Profile[];
  proxies: Proxy[];
  settings: Settings;
  logs: Log[];
  runs: Run[];
  queued: string[];
}
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("saveGroup"), data: groupSchema }).strict(),
  z.object({ type: z.literal("saveTask"), data: taskSchema }).strict(),
  z.object({ type: z.literal("saveProfile"), data: profileSchema }).strict(),
  z.object({ type: z.literal("saveProxy"), data: proxySchema }).strict(),
  z.object({ type: z.literal("settings"), data: settingsSchema }).strict(),
  z
    .object({
      type: z.enum([
        "deleteGroup",
        "deleteTask",
        "duplicateTask",
        "deleteProfile",
        "deleteProxy",
        "start",
        "stop",
        "restart",
        "approve",
      ]),
      id,
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export interface DesktopAPI {
  snapshot(): Promise<Snapshot>;
  command(command: Command): Promise<Snapshot>;
  subscribe(callback: (snapshot: Snapshot) => void): () => void;
}

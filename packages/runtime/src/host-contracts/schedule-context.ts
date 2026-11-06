import { z } from "zod";

/** Opaque, bounded host-owned reference. Runtime must never interpret its contents. */
export const scheduleHostContextSchema = z.string().min(1).max(8192).brand<"ScheduleHostContext">();
export type ScheduleHostContext = z.infer<typeof scheduleHostContextSchema>;

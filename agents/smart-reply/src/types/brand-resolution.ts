import { z } from "zod";
import type { BrandPriorityStrategy } from "./config.ts";
import { BrandPriorityStrategySchema } from "./config.ts";

export const BrandResolutionInputSchema = z.object({
  uiSelectedBrand: z.string().optional(),
  configDefaultBrand: z.string().optional(),
  conversationBrand: z.string().optional(),
  availableBrands: z.array(z.string()),
  strategy: BrandPriorityStrategySchema,
});

export type BrandResolutionInput = z.infer<typeof BrandResolutionInputSchema> & {
  aliasMap?: Map<string, string> | undefined;
};

export const BrandMatchTypeSchema = z.enum(["exact", "fuzzy", "fallback"]);
export type BrandMatchType = z.infer<typeof BrandMatchTypeSchema>;

export const BrandSourceSchema = z.enum(["ui", "conversation", "config", "default"]);
export type BrandSource = z.infer<typeof BrandSourceSchema>;

export const BrandResolutionOutputSchema = z.object({
  resolvedBrand: z.string(),
  matchType: BrandMatchTypeSchema,
  source: BrandSourceSchema,
  reason: z.string(),
  originalInput: z.string().optional(),
});

export type BrandResolutionOutput = z.infer<typeof BrandResolutionOutputSchema>;

export const FuzzyMatchResultSchema = z.object({
  brand: z.string(),
  isExact: z.boolean(),
  originalInput: z.string(),
});

export type FuzzyMatchResult = z.infer<typeof FuzzyMatchResultSchema>;

export const BRAND_RESOLUTION_PRIORITY = {
  "user-selected": ["uiSelectedBrand", "configDefaultBrand", "firstAvailable"] as const,
  "conversation-extracted": [
    "conversationBrand",
    "uiSelectedBrand",
    "configDefaultBrand",
    "firstAvailable",
  ] as const,
  smart: ["conversationBrand", "uiSelectedBrand", "configDefaultBrand", "firstAvailable"] as const,
} as const;

export function isBrandPriorityStrategy(value: unknown): value is BrandPriorityStrategy {
  return BrandPriorityStrategySchema.safeParse(value).success;
}

export interface BrandResolutionContext {
  sources: {
    ui?: string;
    conversation?: string;
    config?: string;
  };
  availableBrands: string[];
  strategy: BrandPriorityStrategy;
  attempts: Array<{
    source: string;
    value: string | undefined;
    matched: boolean;
    reason: string;
  }>;
}

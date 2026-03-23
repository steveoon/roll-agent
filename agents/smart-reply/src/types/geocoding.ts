import { z } from "zod";
import type { Store } from "./zhipin.ts";

export const CoordinatesSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

export type Coordinates = z.infer<typeof CoordinatesSchema>;

export interface StoreWithDistance {
  store: Store;
  distance?: number | undefined;
}

export const CHINA_BOUNDS = {
  minLat: 3.86,
  maxLat: 53.55,
  minLng: 73.66,
  maxLng: 135.05,
} as const;

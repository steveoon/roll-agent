import type { Brand, Store, ZhipinData } from "../types/zhipin.ts";

export function getAllStores(data: ZhipinData): Store[] {
  return data.brands.flatMap((brand) => brand.stores);
}

export function getAvailableBrandNames(data: ZhipinData): string[] {
  return data.brands.map((brand) => brand.name);
}

export function findBrandByName(data: ZhipinData, brandName?: string | null): Brand | undefined {
  if (!brandName) {
    return undefined;
  }
  return data.brands.find((brand) => brand.name === brandName);
}

export function resolveDefaultBrand(data: ZhipinData): Brand | undefined {
  if (data.meta.defaultBrandId) {
    const exact = data.brands.find((brand) => brand.id === data.meta.defaultBrandId);
    if (exact) {
      return exact;
    }
  }
  return data.brands[0];
}

export function resolveDefaultBrandName(data: ZhipinData): string {
  return resolveDefaultBrand(data)?.name ?? "";
}

export function resolvePrimaryCity(data: ZhipinData, brandName?: string | null): string | undefined {
  const stores = brandName ? (findBrandByName(data, brandName)?.stores ?? []) : getAllStores(data);
  return stores.find((store) => typeof store.city === "string" && store.city.trim().length > 0)?.city;
}

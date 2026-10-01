import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

export function commandJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function canonicalJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as Prisma.JsonValue;
  const sort = (item: Prisma.JsonValue): Prisma.JsonValue => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key]!)]),
      );
    return item;
  };
  return JSON.stringify(sort(normalized));
}

export function commandHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

import { createHash } from "node:crypto";

/** A bank movement read from a statement file, before it becomes a bank transaction. */
export type StatementMovement = {
  externalId: string;
  operationDate: string;
  valueDate: string | null;
  /** Signed: negative for debits (cargos), positive for credits (abonos). */
  amountCents: number;
  description: string;
  reference: string | null;
  counterpartyName?: string | null;
};

export type MovementStatus = "NEW" | "DUPLICATE" | "SKIPPED";

export function movementStatus(
  movement: StatementMovement,
  existing: Set<string>,
): MovementStatus {
  if (movement.amountCents === 0) return "SKIPPED";
  return existing.has(movement.externalId) ? "DUPLICATE" : "NEW";
}

export function centsToAmount(cents: number) {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * Stable external IDs: a hash of the movement's identifying fields plus its
 * order among identical movements, so overlapping statements match.
 */
export function movementIdentifier(prefix: string) {
  const occurrences = new Map<string, number>();
  return (key: string) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return `${prefix}:${createHash("sha256").update(`${key}|${occurrence}`).digest("hex")}`;
  };
}

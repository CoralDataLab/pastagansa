import { describe, expect, it } from "vitest";
import { deliveryRetryStorageKey } from "./delivery-retry";

describe("delivery retry storage key", () => {
  it("keeps retries for the same delivery together", () => {
    expect(
      deliveryRetryStorageKey(
        "invoice",
        "invoice-1",
        " Billing@Example.com ",
        " Factura F-001 ",
      ),
    ).toBe(
      deliveryRetryStorageKey(
        "invoice",
        "invoice-1",
        "billing@example.com",
        "Factura F-001",
      ),
    );
  });

  it("allows a new delivery when its recipient or subject changes", () => {
    const initial = deliveryRetryStorageKey(
      "quote",
      "quote-1",
      "billing@example.com",
      "Presupuesto P-001",
    );
    expect(
      deliveryRetryStorageKey(
        "quote",
        "quote-1",
        "other@example.com",
        "Presupuesto P-001",
      ),
    ).not.toBe(initial);
    expect(
      deliveryRetryStorageKey(
        "quote",
        "quote-1",
        "billing@example.com",
        "Presupuesto P-002",
      ),
    ).not.toBe(initial);
  });
});

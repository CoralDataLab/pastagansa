import { describe, expect, it } from "vitest";
import { contactInputSchema, contactPayload } from "./contacts";

describe("contact input", () => {
  it("normalizes a browser form into a customer and supplier", () => {
    const input = contactPayload({
      legalName: "  Cliente Demo SL ",
      tradeName: "",
      email: "facturas@example.com",
      paymentTermsDays: "30",
      paymentMethod: "BANK_TRANSFER",
      isCustomer: "on",
      isSupplier: "on",
    });
    expect(contactInputSchema.parse(input)).toMatchObject({
      legalName: "Cliente Demo SL",
      tradeName: undefined,
      paymentTermsDays: 30,
      isCustomer: true,
      isSupplier: true,
    });
  });

  it("sends the fiscal country for a foreign supplier", () => {
    expect(contactInputSchema.parse(contactPayload({ legalName: "Anthropic Ireland", taxId: "IE4276970QH", taxCountry: "IE", isSupplier: "on" })))
      .toMatchObject({ taxId: "IE4276970QH", taxCountry: "IE" });
  });

  it("supports a supplier-only contact", () => {
    expect(
      contactInputSchema.parse(
        contactPayload({ legalName: "Proveedor Demo", isSupplier: "on" }),
      ),
    ).toMatchObject({ isCustomer: false, isSupplier: true });
  });

  it("requires at least one commercial role", () => {
    expect(
      contactInputSchema.safeParse(
        contactPayload({ legalName: "Contacto sin rol" }),
      ).success,
    ).toBe(false);
  });

  it("rejects invalid payment terms before reaching the API", () => {
    expect(
      contactInputSchema.safeParse({
        legalName: "Cliente",
        paymentTermsDays: 366,
        isCustomer: true,
        isSupplier: false,
      }).success,
    ).toBe(false);
  });
});

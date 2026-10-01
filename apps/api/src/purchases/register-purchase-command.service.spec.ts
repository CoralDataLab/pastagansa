import { ConfigService } from "@nestjs/config";
import { CommandExecutorService } from "../commands/command-executor.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { RegisterPurchaseCommandService } from "./register-purchase-command.service";
import { PurchasesService } from "./purchases.service";

const payload = {
  supplierId: "11111111-1111-4111-8111-111111111111",
  supplierInvoiceNumber: "INV-1",
  issueDate: "2026-09-01",
  receivedDate: "2026-09-02",
  currency: "EUR",
  lines: [
    {
      description: "Consulting",
      quantity: 1,
      unitPrice: 100,
      taxRate: 21,
      deductiblePct: 100,
    },
  ],
};

function setup(enabled = false) {
  const purchases = {
    create: jest.fn().mockResolvedValue({ id: "purchase", status: "DRAFT" }),
  };
  const executor = {
    execute: jest.fn(
      async (
        _context: unknown,
        _command: unknown,
        _permissions: unknown,
        handler: () => Promise<unknown>,
      ) => ({ execution: { result: await handler() } }),
    ),
  };
  const tenant = {
    required: {
      organizationId: "org",
      companyId: "company",
      userId: "user",
      roleCodes: [],
    },
  };
  const config = { get: jest.fn().mockReturnValue(enabled ? "true" : "false") };
  const service = new RegisterPurchaseCommandService(
    executor as unknown as CommandExecutorService,
    purchases as unknown as PurchasesService,
    tenant as unknown as TenantContextService,
    config as unknown as ConfigService,
  );
  return { service, purchases, executor, tenant };
}

describe("RegisterPurchaseCommandService", () => {
  it("preserves legacy creation when the pilot is disabled", async () => {
    const { service, purchases, executor } = setup();
    await expect(service.createDirect(payload)).resolves.toMatchObject({
      id: "purchase",
    });
    expect(purchases.create).toHaveBeenCalledWith(payload);
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it("routes direct creation through the same business handler with a command ID when enabled", async () => {
    const { service, executor, purchases } = setup(true);
    await expect(
      service.createDirect(payload, "direct-1"),
    ).resolves.toMatchObject({ id: "purchase" });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        commandId: "direct-1",
        name: "registrar_factura_recibida",
        version: 1,
        payload,
      }),
      ["purchase_invoice.create"],
      expect.any(Function),
    );
    expect(purchases.create).toHaveBeenCalledTimes(1);
  });
  it("revalidates nested payloads for non-HTTP callers", async () => {
    const { service, tenant, executor, purchases } = setup(true);
    await expect(
      service.execute(tenant.required, "direct-1", { ...payload, lines: [] }),
    ).rejects.toThrow();
    expect(purchases.create).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it("reserves proposal execution IDs from the direct API", async () => {
    const { service, executor } = setup(true);
    await expect(
      service.createDirect(payload, "proposal:other:execute"),
    ).rejects.toThrow("reserved");
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

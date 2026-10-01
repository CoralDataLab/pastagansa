import { ForbiddenException } from "@nestjs/common";
import {
  CommandExecutorService,
  requireCommandId,
} from "./command-executor.service";
import { CommandAuthorizationService } from "./command-authorization.service";
import { canonicalJson, commandHash } from "./command-json";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";

const context = {
  organizationId: "org",
  companyId: "company",
  userId: "user",
  roleCodes: ["untrusted"],
};

function setup() {
  const executions: Array<Record<string, unknown>> = [];
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    commandExecution: {
      findFirst: jest.fn(
        async ({ where }: { where: { commandId: string } }) =>
          executions.find((item) => item.commandId === where.commandId) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const execution = { id: "receipt", ...data };
        executions.push(execution);
        return execution;
      }),
    },
  };
  const tenant = { db } as unknown as TenantContextService;
  const transactions = {
    run: jest.fn(async (_: unknown, work: () => Promise<unknown>) => work()),
  };
  const authorization = { require: jest.fn().mockResolvedValue(context) };
  const executor = new CommandExecutorService(
    transactions as unknown as TenantTransactionService,
    tenant,
    authorization as unknown as CommandAuthorizationService,
  );
  return { executor, db, authorization, transactions };
}

const command = {
  commandId: "c-1",
  name: "registrar_factura_recibida",
  version: 1,
  payload: { supplierId: "supplier", lines: [{ unitPrice: 10, quantity: 1 }] },
  evidence: [],
};

describe("CommandExecutorService", () => {
  it("stores a successful result and returns it on retry without running the handler twice", async () => {
    const { executor, db, authorization } = setup();
    const handler = jest
      .fn()
      .mockResolvedValue({ id: "purchase", status: "DRAFT" });
    const first = await executor.execute(
      context,
      command,
      ["purchase_invoice.create"],
      handler,
    );
    const retry = await executor.execute(
      context,
      command,
      ["purchase_invoice.create"],
      handler,
    );
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.execution).toEqual(first.execution);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(db.commandExecution.create).toHaveBeenCalledTimes(1);
    expect(authorization.require).toHaveBeenCalledTimes(2);
  });

  it("rejects the same command ID with changed payload, evidence, name or version", async () => {
    const { executor } = setup();
    const handler = jest.fn().mockResolvedValue({ id: "purchase" });
    await executor.execute(context, command, [], handler);
    for (const changed of [
      { ...command, payload: { ...command.payload, supplierId: "other" } },
      { ...command, evidence: [{ reference: "other-document" }] },
      { ...command, version: 2 },
      { ...command, name: "other_command" },
    ])
      await expect(
        executor.execute(context, changed, [], handler),
      ).rejects.toThrow("different command data");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not write a successful receipt when the business handler rejects", async () => {
    const { executor, db } = setup();
    await expect(
      executor.execute(context, command, [], async () => {
        throw new Error("Supplier belongs to another company");
      }),
    ).rejects.toThrow("another company");
    expect(db.commandExecution.create).not.toHaveBeenCalled();
  });

  it("re-authorizes even an idempotent retry before reading the receipt", async () => {
    const { executor, authorization, db } = setup();
    const handler = jest.fn().mockResolvedValue({ id: "purchase" });
    await executor.execute(context, command, [], handler);
    db.commandExecution.findFirst.mockClear();
    authorization.require.mockRejectedValueOnce(new ForbiddenException());
    await expect(
      executor.execute(context, command, [], handler),
    ).rejects.toThrow(ForbiddenException);
    expect(db.commandExecution.findFirst).not.toHaveBeenCalled();
  });
});

describe("command canonicalization", () => {
  it("ignores object key order, but retains array order and exact data", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
    );
    expect(commandHash({ values: [1, 2] })).not.toBe(
      commandHash({ values: [2, 1] }),
    );
  });
  it.each(["", " leading", "trailing ", "line\nbreak", "x".repeat(129)])(
    "rejects invalid ID %p",
    (id) => {
      expect(() => requireCommandId(id)).toThrow();
    },
  );
});

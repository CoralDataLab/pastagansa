import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { TenantContextService } from "./tenant-context.service";
import { TenantTransactionService } from "./tenant-transaction.service";

const context = {
  organizationId: "org",
  companyId: "company",
  userId: "user",
  roleCodes: [],
};

function setup() {
  const tenant = new TenantContextService();
  const db = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const prisma = {
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work(db),
    ),
  };
  const transactions = new TenantTransactionService(
    prisma as unknown as PrismaService,
    tenant,
  );
  return { tenant, db, prisma, transactions };
}

describe("TenantTransactionService", () => {
  it("opens a transaction and binds the tenant for a non-HTTP caller", async () => {
    const { transactions, prisma, db, tenant } = setup();
    const result = await transactions.run(context, async () => {
      expect(tenant.required.userId).toBe("user");
      expect(tenant.db).toBe(db);
      return "done";
    });
    expect(result).toBe("done");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tenant.current).toBeUndefined();
  });

  it("joins the existing HTTP transaction rather than committing a nested unit", async () => {
    const { transactions, prisma, db, tenant } = setup();
    await tenant.run(
      { ...context, db: db as unknown as Prisma.TransactionClient },
      () => transactions.run(context, async () => expect(tenant.db).toBe(db)),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { companyId: "other" },
    { organizationId: "other" },
    { userId: "other" },
  ])("rejects switching context within a transaction: %p", async (change) => {
    const { transactions, db, tenant } = setup();
    const work = jest.fn();
    await tenant.run(
      { ...context, db: db as unknown as Prisma.TransactionClient },
      async () => {
        expect(() => transactions.run({ ...context, ...change }, work)).toThrow(
          "Cannot change",
        );
      },
    );
    expect(work).not.toHaveBeenCalled();
  });
});

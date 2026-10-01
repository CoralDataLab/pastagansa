import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { TenantContext, TenantContextService } from "./tenant-context.service";

/** Transaction boundary usable by HTTP adapters and trusted in-process callers.
 * This establishes isolation, not authorization: commands must authorize the actor.
 */
@Injectable()
export class TenantTransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  run<T>(
    context: TenantContext,
    work: () => Promise<T>,
    timeout = 15_000,
  ): Promise<T> {
    const current = this.tenant.current;
    if (current?.db) {
      if (
        current.organizationId !== context.organizationId ||
        current.companyId !== context.companyId ||
        current.userId !== context.userId
      )
        throw new Error("Cannot change tenant or actor within a transaction");
      return work();
    }
    return this.prisma.$transaction(
      async (db) => {
        await db.$queryRaw`SELECT set_config('app.organization_id', ${context.organizationId}, true)`;
        if (context.companyId)
          await db.$queryRaw`SELECT set_config('app.company_id', ${context.companyId}, true)`;
        return this.tenant.run({ ...context, db }, work);
      },
      { maxWait: 5_000, timeout },
    );
  }
}

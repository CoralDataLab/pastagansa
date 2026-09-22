import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { from, lastValueFrom, Observable } from "rxjs";
import { PrismaService } from "../prisma.service";
import { Reflector } from "@nestjs/core";
import { LONG_TENANT_TRANSACTION } from "./long-tenant-transaction.decorator";
import { TenantContextService } from "./tenant-context.service";
import { AuthenticatedRequest } from "./tenant.types";

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.tenant) return next.handle();
    const timeout = this.reflector.getAllAndOverride<boolean>(LONG_TENANT_TRANSACTION,
      [context.getHandler(), context.getClass()]) ? 120_000 : 15_000;
    return from(
      this.prisma.$transaction(
        async (db) => {
          await db.$queryRaw`SELECT set_config('app.organization_id', ${request.tenant!.organizationId}, true)`;
          if (request.tenant!.companyId)
            await db.$queryRaw`SELECT set_config('app.company_id', ${request.tenant!.companyId}, true)`;
          return this.tenantContext.run({ ...request.tenant!, db }, () =>
            lastValueFrom(next.handle()),
          );
        },
        { maxWait: 5_000, timeout },
      ),
    );
  }
}

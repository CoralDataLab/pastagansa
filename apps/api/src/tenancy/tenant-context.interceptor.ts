import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { from, lastValueFrom, Observable } from "rxjs";
import { TenantTransactionService } from "./tenant-transaction.service";
import { Reflector } from "@nestjs/core";
import { LONG_TENANT_TRANSACTION } from "./long-tenant-transaction.decorator";
import { AuthenticatedRequest } from "./tenant.types";

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.tenant) return next.handle();
    const timeout = this.reflector.getAllAndOverride<boolean>(LONG_TENANT_TRANSACTION,
      [context.getHandler(), context.getClass()]) ? 120_000 : 15_000;
    return from(
      this.transactions.run(
        request.tenant,
        () => lastValueFrom(next.handle()),
        timeout,
      ),
    );
  }
}

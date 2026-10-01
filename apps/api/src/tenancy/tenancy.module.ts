import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Global, Module } from "@nestjs/common";
import { AuthenticationGuard } from "../identity/authentication.guard";
import { IdentityModule } from "../identity/identity.module";
import { TenantContextInterceptor } from "./tenant-context.interceptor";
import { TenantContextService } from "./tenant-context.service";
import { TenantGuard } from "./tenant.guard";
import { TenantTransactionService } from "./tenant-transaction.service";

@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    TenantContextService,
    TenantTransactionService,
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [TenantContextService, TenantTransactionService],
})
export class TenancyModule {}

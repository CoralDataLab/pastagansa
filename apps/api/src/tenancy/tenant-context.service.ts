import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

export interface TenantContext {
  organizationId: string;
  companyId?: string;
  userId: string;
  roleCodes: string[];
  db?: Prisma.TransactionClient;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  run<T>(context: TenantContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  get current(): TenantContext | undefined {
    return this.storage.getStore();
  }

  get required(): TenantContext {
    const context = this.storage.getStore();
    if (!context)
      throw new Error("Tenant context is required for this operation");
    return context;
  }

  get db(): Prisma.TransactionClient {
    const db = this.required.db;
    if (!db)
      throw new Error(
        "Tenant database transaction is required for this operation",
      );
    return db;
  }
}

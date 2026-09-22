import { SetMetadata } from "@nestjs/common";

export const LONG_TENANT_TRANSACTION = "long_tenant_transaction";
export const LongTenantTransaction = () => SetMetadata(LONG_TENANT_TRANSACTION, true);

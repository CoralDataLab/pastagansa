import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { CommandExecutorService } from "../commands/command-executor.service";
import { validateCommandInput } from "../commands/validate-command-input";
import {
  TenantContext,
  TenantContextService,
} from "../tenancy/tenant-context.service";
import { CreatePurchaseInvoiceDto } from "./dto/purchase-invoice.dto";
import { PurchasesService } from "./purchases.service";

export const REGISTER_PURCHASE_COMMAND = "registrar_factura_recibida";
export const REGISTER_PURCHASE_COMMAND_VERSION = 1;

@Injectable()
export class RegisterPurchaseCommandService {
  constructor(
    private readonly executor: CommandExecutorService,
    private readonly purchases: PurchasesService,
    private readonly tenant: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  async createDirect(input: CreatePurchaseInvoiceDto, commandId?: string) {
    // Default-off preserves the existing API behavior and requires no new tables at runtime.
    if (this.config.get<string>("AI_NATIVE_ENABLED") !== "true")
      return this.purchases.create(input);
    if (commandId?.startsWith("proposal:"))
      throw new BadRequestException(
        "The proposal command namespace is reserved for reviewed proposals",
      );
    const receipt = await this.execute(
      this.tenant.required,
      commandId ?? randomUUID(),
      input,
    );
    return receipt.execution.result;
  }

  async execute(
    context: TenantContext,
    commandId: string,
    input: unknown,
    evidence: unknown[] = [],
    additionalPermissions: readonly string[] = [],
  ) {
    const payload = await validateCommandInput(CreatePurchaseInvoiceDto, input);
    return this.executor.execute(
      context,
      {
        commandId,
        name: REGISTER_PURCHASE_COMMAND,
        version: REGISTER_PURCHASE_COMMAND_VERSION,
        payload,
        evidence,
      },
      ["purchase_invoice.create", ...additionalPermissions],
      () => this.purchases.create(payload),
    );
  }
}

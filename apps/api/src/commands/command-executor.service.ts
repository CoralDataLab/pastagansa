import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { TenantContext } from "../tenancy/tenant-context.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import { CommandAuthorizationService } from "./command-authorization.service";
import { commandHash, commandJson } from "./command-json";

export interface BusinessCommand<Payload> {
  commandId: string;
  name: string;
  version: number;
  payload: Payload;
  evidence: unknown[];
}

export function requireCommandId(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value.length ||
    value.length > 128 ||
    /[^\x20-\x7e]/.test(value)
  )
    throw new BadRequestException(
      "commandId must contain 1 to 128 printable ASCII characters without surrounding whitespace",
    );
  return value;
}

@Injectable()
export class CommandExecutorService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly tenant: TenantContextService,
    private readonly authorization: CommandAuthorizationService,
  ) {}

  /** Handler must be trusted application code, never supplied by an API caller. */
  execute<Payload>(
    context: TenantContext,
    command: BusinessCommand<Payload>,
    permissions: readonly string[],
    handler: () => Promise<unknown>,
  ) {
    requireCommandId(command.commandId);
    if (
      !/^[a-z][a-z0-9_]{0,99}$/.test(command.name) ||
      !Number.isSafeInteger(command.version) ||
      command.version < 1 ||
      !Array.isArray(command.evidence)
    )
      throw new BadRequestException("Invalid business command envelope");
    return this.transactions.run(context, async () => {
      const scope = await this.authorization.require(permissions);
      const payloadHash = commandHash({
        name: command.name,
        version: command.version,
        payload: command.payload,
        evidence: command.evidence,
      });
      await this.tenant.db.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`command:${scope.companyId}:${command.commandId}`}, 0))::text
      `;
      const existing = await this.tenant.db.commandExecution.findFirst({
        where: {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          commandId: command.commandId,
        },
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new ConflictException(
            "commandId was already used with different command data",
          );
        return { execution: existing, replayed: true };
      }
      // A failed handler rolls back domain writes AND the receipt. No success is recorded.
      const result = await handler();
      const execution = await this.tenant.db.commandExecution.create({
        data: {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          actorUserId: scope.userId,
          commandId: command.commandId,
          name: command.name,
          version: command.version,
          payloadHash,
          payload: commandJson(command.payload),
          evidence: commandJson(command.evidence),
          result: commandJson(result),
        },
      });
      return { execution, replayed: false };
    });
  }
}

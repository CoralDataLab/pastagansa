import { ForbiddenException, Injectable } from "@nestjs/common";
import { TenantContextService } from "../tenancy/tenant-context.service";

@Injectable()
export class CommandAuthorizationService {
  constructor(private readonly tenant: TenantContextService) {}

  /** Re-authorizes from DB; roleCodes and agent provenance are never trusted. */
  async require(permissions: readonly string[]) {
    const { organizationId, companyId, userId } = this.tenant.required;
    if (!companyId)
      throw new ForbiddenException("A company is required for commands");
    const company = await this.tenant.db.company.findFirst({
      where: { id: companyId, organizationId },
      select: { id: true },
    });
    if (!company)
      throw new ForbiddenException(
        "Company is not available in this organization",
      );
    const memberships = await this.tenant.db.membership.findMany({
      where: {
        organizationId,
        userId,
        status: "ACTIVE",
        user: { status: "ACTIVE" },
        OR: [{ companyId }, { companyId: null }],
      },
      select: {
        role: {
          select: {
            permissions: { select: { permission: { select: { code: true } } } },
          },
        },
      },
    });
    const granted = new Set(
      memberships.flatMap((membership) =>
        membership.role.permissions.map(({ permission }) => permission.code),
      ),
    );
    if (
      !memberships.length ||
      permissions.some((permission) => !granted.has(permission))
    )
      throw new ForbiddenException(
        "Missing active membership or command permission",
      );
    return { organizationId, companyId, userId };
  }
}

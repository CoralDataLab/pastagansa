import { CommandAuthorizationService } from "./command-authorization.service";
import { TenantContextService } from "../tenancy/tenant-context.service";

function setup() {
  const db = {
    company: { findFirst: jest.fn().mockResolvedValue({ id: "company" }) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const tenant = {
    required: {
      organizationId: "org",
      companyId: "company",
      userId: "user",
      roleCodes: ["organization.owner"],
    },
    db,
  };
  return {
    db,
    tenant,
    authorization: new CommandAuthorizationService(
      tenant as unknown as TenantContextService,
    ),
  };
}

describe("CommandAuthorizationService", () => {
  it("does not trust roleCodes supplied in the calling context", async () => {
    const { authorization, db } = setup();
    await expect(
      authorization.require(["purchase_invoice.create"]),
    ).rejects.toThrow("membership");
    expect(db.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE",
          user: { status: "ACTIVE" },
          OR: [{ companyId: "company" }, { companyId: null }],
        }),
      }),
    );
  });

  it("requires all permissions and resolves active memberships from the database", async () => {
    const { authorization, db } = setup();
    db.membership.findMany.mockResolvedValue([
      {
        role: {
          permissions: [{ permission: { code: "purchase_invoice.create" } }],
        },
      },
    ] as never);
    await expect(
      authorization.require(["purchase_invoice.create"]),
    ).resolves.toMatchObject({ companyId: "company" });
    await expect(
      authorization.require([
        "purchase_invoice.create",
        "command_proposal.review",
      ]),
    ).rejects.toThrow();
  });

  it("rejects a company from a different organization before resolving permissions", async () => {
    const { authorization, db } = setup();
    db.company.findFirst.mockResolvedValue(null as never);
    await expect(authorization.require([])).rejects.toThrow("organization");
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });
});

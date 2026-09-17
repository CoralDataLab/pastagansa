import * as argon2 from "argon2";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { MembershipStatus, SessionStatus, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { TokenPair, TokenService } from "./token.service";

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(input: RegisterDto): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    const exists = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (exists)
      throw new ConflictException("An account already exists for this email");

    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    const user = await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: { code: "organization.owner" },
        update: {},
        create: { code: "organization.owner", name: "Organization owner" },
      });
      const permissions = await Promise.all(
        [
          ["company.read", "Read company configuration"],
          ["company.update", "Update company configuration"],
          ["company.manage", "Manage companies"],
          ["contact.read", "Read contacts"],
          ["contact.create", "Create contacts"],
          ["contact.update", "Update contacts"],
          ["contact.archive", "Archive contacts"],
          ["catalog.read", "Read catalog"],
          ["catalog.create", "Create catalog items"],
          ["catalog.update", "Update catalog items"],
          ["catalog.archive", "Archive catalog items"],
          ["quote.read", "Read quotations"],
          ["quote.create", "Create quotations"],
          ["quote.update", "Update quotations"],
          ["quote.change_status", "Change quotation status"],
          ["quotes.manage", "Record commercial quote events"],
          ["document_sequence.read", "Read document sequences"],
          ["document_sequence.manage", "Manage document sequences"],
          ["invoice.read", "Read invoices"],
          ["invoice.create", "Create invoice drafts"],
          ["invoice.update", "Update invoice drafts"],
          ["invoice.delete", "Delete invoice drafts"],
          ["invoice.issue", "Issue invoices"],
          ["invoice.send", "Send invoices"],
          ["document.send", "Send documents by email"],
          ["payment.read", "Read invoice payments"],
          ["payment.create", "Record invoice payments"],
          ["collections.read", "Read commercial event timelines"],
          ["collections.manage", "Record commercial collection events"],
          ["tax_rule.read", "Read versioned tax rules"],
          ["tax_ledger.read", "Read tax ledger"],
          ["sif_record.read", "Read SIF records"],
          ["purchase_invoice.read", "Read purchase invoices"],
          ["purchase_invoice.create", "Create purchase invoices"],
          ["purchase_invoice.update", "Update purchase invoices"],
          ["purchase_invoice.approve", "Approve purchase invoices"],
          ["purchase_invoice.ocr", "Request and review purchase invoice OCR"],
          [
            "purchase_invoice.approval_policy.manage",
            "Manage purchase approval policy",
          ],
          ["purchase_invoice.delete", "Delete purchase invoice drafts"],
          ["supplier_payment.read", "Read supplier payments"],
          ["supplier_payment.create", "Record supplier payments"],
          ["account.read", "Read chart of accounts"],
          ["account.manage", "Manage chart of accounts"],
          ["accounting_rule.read", "Read accounting rules"],
          ["accounting_rule.manage", "Manage accounting rules"],
          ["fiscal_year.read", "Read fiscal years and periods"],
          ["fiscal_year.manage", "Manage fiscal years"],
          ["accounting_period.lock", "Lock accounting periods"],
          ["journal_entry.read", "Read journal entries"],
          ["journal_entry.create", "Create manual journal entries"],
          ["journal_entry.reverse", "Reverse journal entries"],
          ["bank_account.read", "Read bank accounts"],
          ["bank_account.manage", "Manage bank accounts"],
          [
            "bank_transaction.read",
            "Read bank transactions and suggestions",
          ],
          ["bank_transaction.import", "Import bank transactions"],
          ["bank_transaction.reconcile", "Reconcile bank transactions"],
        ].map(([code, name]) =>
          tx.permission.upsert({
            where: { code },
            update: {},
            create: { code, name },
          }),
        ),
      );
      await Promise.all(
        permissions.map(({ id: permissionId }) =>
          tx.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: role.id, permissionId } },
            update: {},
            create: { roleId: role.id, permissionId },
          }),
        ),
      );
      const organization = await tx.organization.create({
        data: { name: input.organizationName.trim() },
      });
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${organization.id}, true)`;
      const company = await tx.company.create({
        data: {
          organizationId: organization.id,
          legalName: input.legalName.trim(),
          taxId: input.taxId.trim().toUpperCase(),
        },
      });
      const createdUser = await tx.user.create({
        data: { email, passwordHash, status: UserStatus.ACTIVE },
      });
      await tx.membership.create({
        data: {
          organizationId: organization.id,
          companyId: company.id,
          userId: createdUser.id,
          roleId: role.id,
          status: MembershipStatus.ACTIVE,
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: organization.id,
          companyId: company.id,
          actorUserId: createdUser.id,
          action: "organization.registered",
          entityType: "organization",
          entityId: organization.id,
          metadata: { companyId: company.id },
        },
      });
      return createdUser;
    });
    return this.createSession(user.id);
  }

  async login(input: LoginDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
    });
    if (
      !user?.passwordHash ||
      user.status !== UserStatus.ACTIVE ||
      !(await argon2.verify(user.passwordHash, input.password))
    ) {
      throw new UnauthorizedException("Invalid email or password");
    }
    return this.createSession(user.id);
  }

  async resetPassword(input: ResetPasswordDto): Promise<void> {
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const reset = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, usedAt: true, expiresAt: true },
    });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date())
      throw new BadRequestException("Recovery link is invalid or has expired");

    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    const now = new Date();

    const changed = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return false;

      await tx.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      });
      await tx.session.updateMany({
        where: { userId: reset.userId, status: SessionStatus.ACTIVE },
        data: { status: SessionStatus.REVOKED, revokedAt: now },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: reset.userId, usedAt: null },
        data: { usedAt: now },
      });
      return true;
    });

    if (!changed)
      throw new BadRequestException("Recovery link is invalid or has expired");
  }

  async rotate(refreshToken: string): Promise<TokenPair> {
    const claims = await this.tokens.verifyRefresh(refreshToken);
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findFirst({
        where: {
          id: claims.sessionId,
          userId: claims.userId,
          tokenVersion: claims.version,
          status: SessionStatus.ACTIVE,
          expiresAt: { gt: new Date() },
        },
      });
      if (!session || !(await safeVerify(session.refreshHash, refreshToken)))
        throw new UnauthorizedException("Refresh token is no longer valid");
      const nextVersion = session.tokenVersion + 1;
      const next = await this.tokens.issue(
        session.userId,
        session.id,
        nextVersion,
      );
      const refreshHash = await argon2.hash(next.refreshToken, {
        type: argon2.argon2id,
      });
      const changed = await tx.session.updateMany({
        where: {
          id: session.id,
          status: SessionStatus.ACTIVE,
          tokenVersion: session.tokenVersion,
          refreshHash: session.refreshHash,
        },
        data: {
          refreshHash,
          tokenVersion: nextVersion,
          lastUsedAt: new Date(),
        },
      });
      if (changed.count !== 1)
        throw new UnauthorizedException("Refresh token was already used");
      return next;
    });
  }

  async sessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return sessions.map((session) => ({
      ...session,
      status:
        session.status === SessionStatus.ACTIVE &&
        session.expiresAt <= new Date()
          ? "EXPIRED"
          : session.status,
      isCurrent: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, status: SessionStatus.ACTIVE },
      data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
    });
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    input: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (
      !user?.passwordHash ||
      !(await safeVerify(user.passwordHash, input.currentPassword))
    )
      throw new UnauthorizedException("Current password is incorrect");

    const passwordHash = await argon2.hash(input.newPassword, {
      type: argon2.argon2id,
    });
    const now = new Date();
    const changed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, passwordHash: user.passwordHash },
        data: { passwordHash },
      });
      if (updated.count !== 1) return false;
      await tx.session.updateMany({
        where: {
          userId,
          id: { not: currentSessionId },
          status: SessionStatus.ACTIVE,
        },
        data: { status: SessionStatus.REVOKED, revokedAt: now },
      });
      return true;
    });
    if (!changed)
      throw new UnauthorizedException(
        "Password changed concurrently; authenticate again",
      );
  }

  async context(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
          select: {
            companyId: true,
            organization: { select: { id: true, name: true } },
            role: {
              select: {
                code: true,
                name: true,
                permissions: {
                  select: { permission: { select: { code: true } } },
                },
              },
            },
          },
          orderBy: [{ organizationId: "asc" }, { companyId: "asc" }],
        },
      },
    });
    const companies = new Map(
      (
        await Promise.all(
          user.memberships.map(async ({ organization, companyId }) => {
            if (!companyId) return undefined;
            return this.prisma.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('app.organization_id', ${organization.id}, true)`;
              return tx.company.findFirst({
                where: { id: companyId, organizationId: organization.id },
                select: {
                  id: true,
                  legalName: true,
                  taxId: true,
                  country: true,
                  baseCurrency: true,
                  timezone: true,
                },
              });
            });
          }),
        )
      )
        .filter((company) => company !== null && company !== undefined)
        .map((company) => [company.id, company]),
    );
    return {
      ...user,
      memberships: user.memberships.map(
        ({ role, companyId, ...membership }) => ({
          ...membership,
          company: companyId ? (companies.get(companyId) ?? null) : null,
          role: {
            code: role.code,
            name: role.name,
            permissions: role.permissions.map(
              ({ permission }) => permission.code,
            ),
          },
        }),
      ),
    };
  }

  async revoke(userId: string, sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId, status: SessionStatus.ACTIVE },
      data: { status: SessionStatus.REVOKED, revokedAt: new Date() },
    });
  }

  private async createSession(userId: string): Promise<TokenPair> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          userId,
          refreshHash: "pending",
          expiresAt: this.tokens.refreshExpiresAt(),
        },
      });
      const tokens = await this.tokens.issue(userId, session.id, 0);
      await tx.session.update({
        where: { id: session.id },
        data: {
          refreshHash: await argon2.hash(tokens.refreshToken, {
            type: argon2.argon2id,
          }),
        },
      });
      return tokens;
    });
  }
}

async function safeVerify(hash: string, value: string) {
  try {
    return await argon2.verify(hash, value);
  } catch {
    return false;
  }
}

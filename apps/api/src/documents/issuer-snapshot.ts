import { Prisma } from "@prisma/client";

export const ISSUER_SNAPSHOT_VERSION = 1;

export type IssuerSnapshot = {
  version: number;
  source: "company_profile" | "legacy_backfill";
  legalName?: string;
  soleShareholder?: boolean;
  taxId?: string;
  tradeName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  province?: string | null;
  addressCountry?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  bankIban?: string | null;
  paymentInstructions?: string | null;
  paymentTerms?: string | null;
  defaultNotes?: string | null;
  documentFooter?: string | null;
  primaryColor?: string | null;
  logo?: {
    mediaType: "image/png" | "image/jpeg";
    sha256: string;
    width: number;
    height: number;
  } | null;
};

type CompanyForIssuerSnapshot = {
  legalName: string;
  soleShareholder?: boolean;
  taxId: string;
  documentProfile: {
    tradeName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    province: string | null;
    addressCountry: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    bankIban: string | null;
    paymentInstructions: string | null;
    paymentTerms: string | null;
    defaultNotes: string | null;
    documentFooter: string | null;
    primaryColor: string | null;
  } | null;
  documentLogo: {
    mediaType: string;
    sha256: string;
    width: number;
    height: number;
    content: Uint8Array;
  } | null;
};

export function captureIssuerSnapshot(company: CompanyForIssuerSnapshot) {
  const profile = company.documentProfile;
  const logo = company.documentLogo;
  const snapshot: IssuerSnapshot = {
    version: ISSUER_SNAPSHOT_VERSION,
    source: "company_profile",
    legalName: company.legalName,
    soleShareholder: company.soleShareholder ?? false,
    taxId: company.taxId,
    tradeName: profile?.tradeName ?? null,
    addressLine1: profile?.addressLine1 ?? null,
    addressLine2: profile?.addressLine2 ?? null,
    postalCode: profile?.postalCode ?? null,
    city: profile?.city ?? null,
    province: profile?.province ?? null,
    addressCountry: profile?.addressCountry ?? null,
    email: profile?.email ?? null,
    phone: profile?.phone ?? null,
    website: profile?.website ?? null,
    bankIban: profile?.bankIban ?? null,
    paymentInstructions: profile?.paymentInstructions ?? null,
    paymentTerms: profile?.paymentTerms ?? null,
    defaultNotes: profile?.defaultNotes ?? null,
    documentFooter: profile?.documentFooter ?? null,
    primaryColor: profile?.primaryColor ?? null,
    logo: logo
      ? {
          mediaType: logo.mediaType as "image/png" | "image/jpeg",
          sha256: logo.sha256,
          width: logo.width,
          height: logo.height,
        }
      : null,
  };
  return {
    issuerSnapshot: snapshot as Prisma.InputJsonValue,
    issuerSnapshotVersion: ISSUER_SNAPSHOT_VERSION,
    issuerLogoMediaType: logo?.mediaType ?? null,
    issuerLogoSha256: logo?.sha256 ?? null,
    issuerLogoContent: logo?.content ?? null,
  };
}

export function readIssuerSnapshot(
  value: unknown,
  legacy: { legalName?: string | null; taxId?: string | null } = {},
): IssuerSnapshot {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.version === "number" && typeof snapshot.source === "string")
      return snapshot as IssuerSnapshot;
  }
  return {
    version: ISSUER_SNAPSHOT_VERSION,
    source: "legacy_backfill",
    legalName: legacy.legalName ?? undefined,
    taxId: legacy.taxId ?? undefined,
  };
}

export function issuerDisplayName(snapshot: IssuerSnapshot) {
  return snapshot.tradeName || snapshot.legalName || "Emisor no disponible";
}

export function issuerLegalName(snapshot: IssuerSnapshot) {
  return snapshot.legalName || "Emisor no disponible";
}

export function issuerUnipersonalMention(snapshot: IssuerSnapshot) {
  return snapshot.soleShareholder && !/sociedad unipersonal/i.test(issuerLegalName(snapshot))
    ? "Sociedad Unipersonal"
    : null;
}

export function issuerAddressLines(snapshot: IssuerSnapshot) {
  return [
    snapshot.addressLine1,
    snapshot.addressLine2,
    [snapshot.postalCode, snapshot.city].filter(Boolean).join(" ") || null,
    [snapshot.province, snapshot.addressCountry].filter(Boolean).join(" · ") || null,
  ].filter((line): line is string => Boolean(line));
}

export function issuerContactLines(snapshot: IssuerSnapshot) {
  return [snapshot.email, snapshot.phone, snapshot.website].filter(
    (line): line is string => Boolean(line),
  );
}

export function issuerPrimaryColor(snapshot: IssuerSnapshot) {
  return snapshot.primaryColor && /^#[0-9A-F]{6}$/i.test(snapshot.primaryColor)
    ? snapshot.primaryColor.toUpperCase()
    : "#F71950";
}

export function truncatePdfText(value: string, maximum = 700) {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

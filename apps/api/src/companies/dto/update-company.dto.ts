import { Type } from "class-transformer";
import { AeatEnvironment, SifMode } from "@prisma/client";
import {
  IsEmail,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { IsCurrencyCode, IsNotBlank } from "../../common/validation";

export class UpdateCompanyDocumentProfileDto {
  @IsOptional() @IsString() @MaxLength(240) tradeName?: string | null;
  @IsOptional() @IsString() @MaxLength(240) addressLine1?: string | null;
  @IsOptional() @IsString() @MaxLength(240) addressLine2?: string | null;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string | null;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsString() @MaxLength(120) province?: string | null;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/) addressCountry?: string | null;
  @IsOptional() @IsEmail() @MaxLength(320) email?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsUrl({ protocols: ["http", "https"], require_protocol: true }) @MaxLength(500) website?: string | null;
  @IsOptional() @IsString() @MaxLength(42) bankIban?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) paymentInstructions?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) paymentTerms?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) defaultNotes?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) documentFooter?: string | null;
  @IsOptional() @Matches(/^#[0-9A-Fa-f]{6}$/) primaryColor?: string | null;
  @IsOptional() @IsString() @MaxLength(300) invoiceEmailSubjectTemplate?: string | null;
  @IsOptional() @IsString() @MaxLength(300) quoteEmailSubjectTemplate?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) emailBodyTemplate?: string | null;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  @IsNotBlank()
  legalName?: string;

  @IsOptional() @IsBoolean()
  soleShareholder?: boolean;

  @IsOptional()
  @IsCurrencyCode()
  baseCurrency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsEnum(SifMode)
  sifMode?: SifMode;

  @IsOptional()
  @IsEnum(AeatEnvironment)
  aeatEnvironment?: AeatEnvironment;

  @IsOptional() @IsString() @MaxLength(120)
  sifSoftwareProducerName?: string | null;

  @IsOptional() @IsString() @MaxLength(40)
  sifSoftwareProducerTaxId?: string | null;

  @IsOptional() @IsString() @MaxLength(30)
  sifSoftwareName?: string | null;

  @IsOptional() @Matches(/^[A-Z0-9]{2}$/)
  sifSoftwareId?: string | null;

  @IsOptional() @IsString() @MaxLength(50)
  sifSoftwareVersion?: string | null;

  @IsOptional() @IsString() @MaxLength(100)
  sifInstallationNumber?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateCompanyDocumentProfileDto)
  documentProfile?: UpdateCompanyDocumentProfileDto;
}

import { Type } from "class-transformer";
import { Equals, IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from "class-validator";

export class VatRecoveryReviewDto {
  @Equals(true)
  fiscalReviewConfirmed!: true;

  @Equals(true)
  exclusionsReviewed!: true;

  @IsDateString()
  legalEventDate!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  legalEventReference!: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  claimEvidenceReference?: string;
}

export class IssueInvoiceDto {
  @IsUUID() sequenceId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VatRecoveryReviewDto)
  vatRecoveryReview?: VatRecoveryReviewDto;
}

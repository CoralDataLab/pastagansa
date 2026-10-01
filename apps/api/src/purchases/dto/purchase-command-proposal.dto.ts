import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  Matches,
} from "class-validator";
import { CommandProposalStatus } from "@prisma/client";
import { IsNotBlank } from "../../common/validation";
import { CreatePurchaseInvoiceDto } from "./purchase-invoice.dto";

export class CommandEvidenceDto {
  @IsString() @IsNotBlank() @MaxLength(1000) reference!: string;
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) sha256?: string;
  @IsOptional() @IsString() @MaxLength(240) description?: string;
}

export class CommandProvenanceDto {
  @IsIn(["FRONTEND", "API", "EMAIL", "UPLOAD"]) channel!: string;
  @IsOptional() @IsString() @IsNotBlank() @MaxLength(120) agentId?: string;
  @IsOptional() @IsString() @IsNotBlank() @MaxLength(120) agentVersion?: string;
}

export class CreatePurchaseCommandProposalDto {
  @IsString()
  @Matches(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/)
  @MaxLength(128)
  commandId!: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => CreatePurchaseInvoiceDto)
  payload!: CreatePurchaseInvoiceDto;
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CommandEvidenceDto)
  evidence: CommandEvidenceDto[] = [];
  @IsDefined()
  @ValidateNested()
  @Type(() => CommandProvenanceDto)
  provenance!: CommandProvenanceDto;
}

export class ExecutePurchaseCommandProposalDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePurchaseInvoiceDto)
  payload?: CreatePurchaseInvoiceDto;
  @IsString() @IsNotBlank() @MaxLength(1000) reason!: string;
}

export class RejectPurchaseCommandProposalDto {
  @IsString() @IsNotBlank() @MaxLength(1000) reason!: string;
}

export class AssignPurchaseCommandProposalDto {
  @IsUUID() assignedToId!: string;
  @IsString() @IsNotBlank() @MaxLength(1000) reason!: string;
}

export class ListPurchaseCommandProposalsDto {
  @IsOptional() @IsEnum(CommandProposalStatus) status?: CommandProposalStatus;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

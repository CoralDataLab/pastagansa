import { BankTransactionStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { IsNotBlank } from "../../common/validation";

export class CreateBankAccountDto {
  @IsUUID() accountId!: string;
  @IsString() @IsNotBlank() @MaxLength(240) name!: string;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}[A-Za-z0-9 ]{13,32}$/)
  iban?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) currency = "EUR";
}

export class BankTransactionDto {
  @IsString() @IsNotBlank() @MaxLength(240) externalId!: string;
  @IsDateString() bookingDate!: string;
  @IsOptional() @IsDateString() valueDate?: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  amount!: number;
  @IsString() @IsNotBlank() @MaxLength(1000) description!: string;
  @IsOptional() @IsString() @MaxLength(240) counterpartyName?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}[A-Za-z0-9 ]{13,32}$/)
  counterpartyIban?: string;
  @IsOptional() @IsString() @MaxLength(240) reference?: string;
}

export class ImportBankTransactionsDto {
  @IsUUID() bankAccountId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BankTransactionDto)
  transactions!: BankTransactionDto[];
}

export class ListBankTransactionsDto {
  @IsOptional() @IsUUID() bankAccountId?: string;
  @IsOptional() @IsEnum(BankTransactionStatus) status?: BankTransactionStatus;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class SuggestReconciliationsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(30) windowDays = 7;
}

export class ReconcileBankTransactionDto {
  @IsUUID() journalLineId!: string;
}

import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { IsCurrencyCode, IsNotBlank } from "../../common/validation";

export class InvoiceLineDto {
  @IsOptional() @IsUUID() catalogItemId?: string;
  @IsOptional() @IsUUID() taxRuleId?: string;
  @IsOptional() @IsString() @MaxLength(100) exemptionReason?: string;
  @IsString() @MaxLength(2000) @IsNotBlank() description!: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPct?: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;
}

export class CreateInvoiceDto {
  @IsUUID() contactId!: string;
  @IsDateString() issueDate!: string;
  @IsOptional() @IsDateString() operationDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsCurrencyCode() currency?: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
}

export class UpdateInvoiceDto extends CreateInvoiceDto {}

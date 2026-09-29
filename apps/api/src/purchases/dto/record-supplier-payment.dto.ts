import { PaymentMethod } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class RecordSupplierPaymentDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsDateString()
  paidAt!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional() @IsBoolean()
  paidByShareholder?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { PaymentMethod } from "@prisma/client";
import { IsNotBlank } from "../../common/validation";

export class CreateContactDto {
  @IsString()
  @MaxLength(240)
  @IsNotBlank()
  legalName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  tradeName?: string;

  @IsOptional() @IsString() @MaxLength(40)
  taxId?: string;

  @IsOptional() @Matches(/^[A-Za-z]{2}$/)
  taxCountry?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;

  @IsBoolean()
  isCustomer!: boolean;

  @IsBoolean()
  isSupplier!: boolean;
}

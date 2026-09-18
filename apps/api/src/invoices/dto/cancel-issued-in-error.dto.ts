import {
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
  Equals,
} from "class-validator";

export class CancelIssuedInErrorDto {
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  reason!: string;

  @IsBoolean()
  @Equals(true)
  operationDidNotExist!: boolean;
}

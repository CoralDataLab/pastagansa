import { Equals, IsBoolean, IsString, MaxLength, MinLength } from "class-validator";

export class RecoverRejectedRegistrationDto {
  @IsBoolean()
  @Equals(true)
  invoiceDataConfirmed!: boolean;

  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  resolutionNote!: string;
}

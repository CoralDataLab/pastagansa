import { IsDateString } from "class-validator";

export class ExportSifPeriodDto {
  @IsDateString({ strict: true }) from!: string;
  @IsDateString({ strict: true }) to!: string;
}

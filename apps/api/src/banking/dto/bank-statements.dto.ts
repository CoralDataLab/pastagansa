import { plainToInstance, Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { IsNotBlank } from "../../common/validation";
import { INSPECT_ROWS, TableMapping } from "../table-statement";

const DELIMITERS = [";", ",", "\t", "|"];

export class PreviewNorma43Dto {
  /** Target for a single-account statement whose IBAN is not linked to any bank account. */
  @IsOptional() @IsUUID() bankAccountId?: string;
}

export class ImportNorma43Dto extends PreviewNorma43Dto {
  @Matches(/^[0-9a-fA-F]{64}$/) fileSha256!: string;
}

export class TableMappingDto implements TableMapping {
  @IsInt() @Min(0) @Max(INSPECT_ROWS - 1) headerRow!: number;
  @IsOptional() @IsIn(DELIMITERS) delimiter?: string;
  @IsString() @IsNotBlank() @MaxLength(240) dateColumn!: string;
  @IsOptional() @IsString() @MaxLength(240) valueDateColumn?: string;
  @IsIn(["SIGNED", "SPLIT"]) amountMode!: "SIGNED" | "SPLIT";
  @ValidateIf((mapping: TableMappingDto) => mapping.amountMode === "SIGNED")
  @IsString()
  @IsNotBlank()
  @MaxLength(240)
  amountColumn?: string;
  @ValidateIf((mapping: TableMappingDto) => mapping.amountMode === "SPLIT")
  @IsString()
  @IsNotBlank()
  @MaxLength(240)
  debitColumn?: string;
  @ValidateIf((mapping: TableMappingDto) => mapping.amountMode === "SPLIT")
  @IsString()
  @IsNotBlank()
  @MaxLength(240)
  creditColumn?: string;
  @IsIn([",", "."]) decimalSeparator!: "," | ".";
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(240, { each: true })
  descriptionColumns!: string[];
  @IsOptional() @IsString() @MaxLength(240) referenceColumn?: string;
  @IsOptional() @IsString() @MaxLength(240) counterpartyColumn?: string;
}

export class InspectTableDto {
  @IsUUID() bankAccountId!: string;
  @IsOptional() @IsIn(DELIMITERS) delimiter?: string;
}

/** Multipart fields are text, so the mapping arrives as JSON. */
function mappingFromJson({ value }: { value: unknown }) {
  if (typeof value !== "string") return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? plainToInstance(TableMappingDto, parsed)
    : value;
}

export class PreviewTableDto {
  @IsUUID() bankAccountId!: string;
  @Transform(mappingFromJson) @ValidateNested() mapping!: TableMappingDto;
}

export class ImportTableDto extends PreviewTableDto {
  @Matches(/^[0-9a-fA-F]{64}$/) fileSha256!: string;
}

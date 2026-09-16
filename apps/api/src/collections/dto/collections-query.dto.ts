import { Transform } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";

export const collectionBuckets = ["DUE_THIS_WEEK", "OVERDUE_1_7", "OVERDUE_8_30", "OVERDUE_31_60", "OVERDUE_61_90", "OVERDUE_90_PLUS"] as const;
export type CollectionBucket = (typeof collectionBuckets)[number];

export class CollectionsQueryDto {
  @IsOptional() @IsDateString()
  asOf?: string;

  @IsOptional() @IsUUID()
  contactId?: string;

  @IsOptional() @IsIn(collectionBuckets)
  bucket?: CollectionBucket;

  @IsOptional() @IsIn(["OPEN", "DISPUTED", "PROMISED"])
  status?: "OPEN" | "DISPUTED" | "PROMISED";

  @IsOptional() @IsString() @MaxLength(240)
  text?: string;

  @IsOptional() @IsString()
  cursor?: string;

  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100)
  limit = 50;
}

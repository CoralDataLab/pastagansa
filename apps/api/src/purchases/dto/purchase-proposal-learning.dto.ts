import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { IsNotBlank } from "../../common/validation";

export class ListPurchaseProposalLearningCandidatesDto {
  @IsOptional()
  @IsIn(["PENDING_REVIEW", "APPROVED", "REJECTED"])
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED" = "PENDING_REVIEW";
}

export class ReviewPurchaseProposalLearningCandidateDto {
  @IsString()
  @IsNotBlank()
  @MaxLength(1000)
  reason!: string;
}

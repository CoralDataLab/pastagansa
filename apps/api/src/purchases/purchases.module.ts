import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TaxModule } from "../tax/tax.module";
import { AccountingModule } from "../accounting/accounting.module";
import { PurchasesController } from "./purchases.controller";
import { PurchasesService } from "./purchases.service";
import { SupplierPaymentsService } from "./supplier-payments.service";
import { PurchaseAttachmentsService } from "./purchase-attachments.service";
import { PurchaseApprovalPolicyController } from "./purchase-approval-policy.controller";
import { PurchaseApprovalPolicyService } from "./purchase-approval-policy.service";
import { PurchaseOcrController } from "./purchase-ocr.controller";
import { PurchaseOcrEngine } from "./purchase-ocr-engine.service";
import { PurchaseOcrService } from "./purchase-ocr.service";
import { PurchaseOcrWorker } from "./purchase-ocr.worker";
import { PurchaseProposalDocumentsService } from "./purchase-proposal-documents.service";
import { CommandsModule } from "../commands/commands.module";
import { RegisterPurchaseCommandService } from "./register-purchase-command.service";
import { PurchaseCommandProposalsService } from "./purchase-command-proposals.service";
import { PurchaseCommandProposalsController } from "./purchase-command-proposals.controller";

@Module({
  imports: [AuditModule, TaxModule, AccountingModule, CommandsModule],
  controllers: [
    PurchasesController,
    PurchaseCommandProposalsController,
    PurchaseApprovalPolicyController,
    PurchaseOcrController,
  ],
  providers: [
    PurchasesService,
    RegisterPurchaseCommandService,
    PurchaseCommandProposalsService,
    PurchaseProposalDocumentsService,
    SupplierPaymentsService,
    PurchaseAttachmentsService,
    PurchaseApprovalPolicyService,
    PurchaseOcrService,
    PurchaseOcrEngine,
    PurchaseOcrWorker,
  ],
})
export class PurchasesModule {}

import { forwardProposalIntake } from "@/lib/server-purchase-proposal-intake";
export async function POST(request: Request) {
  return forwardProposalIntake(request, "ocr-preview");
}

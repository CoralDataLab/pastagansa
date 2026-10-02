import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";

export async function GET() {
  return forwardPurchaseProposal("/learning-candidates/summary");
}

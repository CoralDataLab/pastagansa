import { z } from "zod";
import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const route = z.object({ id: z.uuid() }).parse(await params);
  return forwardPurchaseProposal(`/${route.id}/learning-hints`);
}

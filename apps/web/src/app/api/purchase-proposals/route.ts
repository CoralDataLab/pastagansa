import { NextResponse } from "next/server";
import { z } from "zod";
import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";
const querySchema = z.object({
  status: z.enum(["PENDING_REVIEW", "EXECUTED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export async function GET(request: Request) {
  const query = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success)
    return NextResponse.json(
      { error: "Filtro de propuestas no válido." },
      { status: 400 },
    );
  const params = new URLSearchParams({ limit: String(query.data.limit) });
  if (query.data.status) params.set("status", query.data.status);
  return forwardPurchaseProposal(`?${params}`);
}

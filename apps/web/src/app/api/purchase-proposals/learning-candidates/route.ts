import { NextResponse } from "next/server";
import { z } from "zod";
import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const input = z
    .object({
      status: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).default("PENDING_REVIEW"),
    })
    .safeParse({ status: url.searchParams.get("status") ?? undefined });
  if (!input.success)
    return NextResponse.json({ error: "Filtro de aprendizaje no válido." }, { status: 400 });
  return forwardPurchaseProposal(`/learning-candidates?status=${input.data.status}`);
}

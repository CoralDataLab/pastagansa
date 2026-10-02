import { NextResponse } from "next/server";
import { z } from "zod";
import { learningCandidateReviewSchema } from "@/lib/purchase-proposals";
import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; action: string }> },
) {
  const route = z
    .object({ candidateId: z.uuid(), action: z.enum(["approve", "reject"]) })
    .safeParse(await params);
  if (!route.success)
    return NextResponse.json(
      { error: "Decisión de aprendizaje no válida." },
      { status: 400 },
    );
  const input = learningCandidateReviewSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!input.success)
    return NextResponse.json(
      { error: "Indica un motivo para la decisión." },
      { status: 400 },
    );
  return forwardPurchaseProposal(
    `/learning-candidates/${route.data.candidateId}/${route.data.action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.data),
    },
  );
}

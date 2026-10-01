import { NextResponse } from "next/server";
import { z } from "zod";
import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const route = z.object({ id: z.uuid() }).safeParse(await params);
  if (!route.success)
    return NextResponse.json({ error: "Propuesta no válida." }, { status: 400 });
  return forwardPurchaseProposal(`/${route.data.id}/projection`);
}

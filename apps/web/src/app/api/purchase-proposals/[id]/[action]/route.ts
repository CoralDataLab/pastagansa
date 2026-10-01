import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assignProposalSchema,
  executeProposalSchema,
  rejectProposalSchema,
} from "@/lib/purchase-proposals";
import { forwardPurchaseProposal } from "@/lib/server-purchase-proposals";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const route = z
    .object({ id: z.uuid(), action: z.enum(["assign", "execute", "reject"]) })
    .safeParse(await params);
  if (!route.success)
    return NextResponse.json(
      { error: "Acción de revisión no válida." },
      { status: 400 },
    );
  const schema =
    route.data.action === "execute"
      ? executeProposalSchema
      : route.data.action === "assign"
        ? assignProposalSchema
        : rejectProposalSchema;
  const input = schema.safeParse(await request.json().catch(() => undefined));
  if (!input.success)
    return NextResponse.json(
      {
        error: "Revisa el motivo y los datos de la factura.",
        issues: input.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  return forwardPurchaseProposal(`/${route.data.id}/${route.data.action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.data),
  });
}

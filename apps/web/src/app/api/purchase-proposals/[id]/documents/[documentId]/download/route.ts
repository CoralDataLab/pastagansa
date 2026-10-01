import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const input = z
    .object({ id: z.uuid(), documentId: z.uuid() })
    .safeParse(await params);
  if (!input.success)
    return NextResponse.json(
      { error: "Documento no válido." },
      { status: 400 },
    );
  try {
    const response = await tenantApiRequest(
      `/v1/purchase-command-proposals/${input.data.id}/documents/${input.data.documentId}/download`,
    );
    if (!response.ok)
      return NextResponse.json(
        {
          error: normalizeApiError(
            await response.json().catch(() => undefined),
          ),
        },
        { status: response.status },
      );
    return new NextResponse(response.body, {
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition":
          response.headers.get("content-disposition") ?? "attachment",
      },
    });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    return NextResponse.json(
      { error: "No podemos conectar con el servicio." },
      { status: 503 },
    );
  }
}

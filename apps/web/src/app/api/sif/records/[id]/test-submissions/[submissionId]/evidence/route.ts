import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; submissionId: string }> },
) {
  const values = await params;
  const id = z.uuid().safeParse(values.id);
  const submissionId = z.uuid().safeParse(values.submissionId);
  if (!id.success || !submissionId.success)
    return NextResponse.json({ error: "Remisión AEAT no válida." }, { status: 400 });
  try {
    const response = await tenantApiRequest(
      `/v1/sif/records/${id.data}/submissions/${submissionId.data}/evidence`,
    );
    if (!response.ok)
      return NextResponse.json(
        { error: normalizeApiError(await response.json().catch(() => undefined)) },
        { status: response.status },
      );
    return new NextResponse(response.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": response.headers.get("content-disposition") ??
          `attachment; filename="aeat-${submissionId.data}-evidence.json"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "No podemos descargar la evidencia AEAT." }, { status: 503 });
  }
}

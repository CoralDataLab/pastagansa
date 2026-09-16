import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success)
    return NextResponse.json({ error: "Registro SIF no válido." }, { status: 400 });
  try {
    const response = await tenantApiRequest(`/v1/sif/records/${id.data}/xml`);
    if (!response.ok)
      return NextResponse.json(
        { error: normalizeApiError(await response.json().catch(() => undefined)) },
        { status: response.status },
      );
    return new NextResponse(response.body, {
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/xml; charset=utf-8",
        "content-disposition": response.headers.get("content-disposition") ?? "attachment; filename=registro-sif.xml",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json(
      { error: "No podemos descargar el XML SIF." },
      { status: 503 },
    );
  }
}

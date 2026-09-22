import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = date.safeParse(url.searchParams.get("from"));
  const to = date.safeParse(url.searchParams.get("to"));
  if (!from.success || !to.success)
    return NextResponse.json({ error: "Indica un período con fechas válidas." }, { status: 400 });
  try {
    const query = new URLSearchParams({ from: from.data, to: to.data });
    const response = await tenantApiRequest(`/v1/sif/records/period-export?${query}`);
    if (!response.ok)
      return NextResponse.json(
        { error: normalizeApiError(await response.json().catch(() => undefined)) },
        { status: response.status },
      );
    return new NextResponse(response.body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": response.headers.get("content-disposition") ?? "attachment; filename=sif-periodo.zip",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "No podemos descargar el período SIF." }, { status: 503 });
  }
}

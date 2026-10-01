import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function POST(request: Request, context: Context) {
  const id = z.uuid().safeParse((await context.params).id);
  const incoming = await request.formData().catch(() => undefined);
  const file = incoming?.get("file");
  if (!id.success || !(file instanceof File) || file.size === 0)
    return NextResponse.json(
      { error: "Selecciona un documento válido." },
      { status: 400 },
    );
  const body = new FormData();
  body.set("file", file, file.name);
  return forward(`/v1/purchase-command-proposals/${id.data}/documents`, {
    method: "POST",
    body,
  });
}

type Context = { params: Promise<{ id: string }> };

async function forward(path: string, init?: RequestInit) {
  try {
    const response = await tenantApiRequest(path, init);
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json(
        { error: normalizeApiError(body) },
        { status: response.status },
      );
    return NextResponse.json(body, { status: response.status });
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

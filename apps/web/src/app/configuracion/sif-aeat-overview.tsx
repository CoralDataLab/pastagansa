"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

type SubmissionStatus = "PENDING" | "SENDING" | "RETRY" | "UNKNOWN" | "FAILED" |
  "ACCEPTED" | "ACCEPTED_WITH_ERRORS" | "REJECTED";
type RecordType = "REGISTRATION" | "SUBSANATION" | "CANCELLATION";

type Overview = {
  companyId: string;
  counts: Record<SubmissionStatus, number>;
  attention: Array<{
    id: string;
    status: SubmissionStatus;
    attempts: number;
    availableAt: string;
    lastAttemptAt: string | null;
    lastError: string | null;
    chainPosition: string;
    invoiceId: string;
    invoiceNumber: string;
  }>;
  review: Array<{
    id: string;
    status: SubmissionStatus;
    recordStatus: string | null;
    errorCode: string | null;
    errorDescription: string | null;
    lastError: string | null;
    csv: string | null;
    recordType: RecordType;
    chainPosition: string;
    invoiceId: string;
    invoiceNumber: string;
    followUps: Array<{ recordType: RecordType; chainPosition: string; status: SubmissionStatus | null }>;
    reviewKind: "FOLLOW_UP_RECORDED" | "TIMESTAMP_SUBSANATION_CANDIDATE" | "REJECTED_REGISTRATION_REVIEW" | "GLOBAL_REJECTION_REVIEW" | "MANUAL_REVIEW";
  }>;
};

function recordTypeLabel(type: RecordType) {
  return type === "REGISTRATION" ? "Alta" : type === "SUBSANATION" ? "Subsanación" : "Anulación";
}

function outcomeLabel(status: SubmissionStatus) {
  return status === "ACCEPTED_WITH_ERRORS" ? "Aceptado con errores" : "Rechazado";
}

function followUpLabel(status: SubmissionStatus | null) {
  if (status === "ACCEPTED") return "aceptado";
  if (status === "ACCEPTED_WITH_ERRORS") return "aceptado con errores";
  if (status === "REJECTED") return "rechazado";
  if (status === "UNKNOWN") return "incierto";
  if (status === "FAILED") return "fallido";
  return "en curso";
}

export function SifAeatOverview({ companyId }: { companyId: string }) {
  const overview = useQuery({
    queryKey: ["sif-aeat-overview", companyId],
    queryFn: async (): Promise<Overview> => {
      const response = await fetch("/api/sif/records/test-submissions/overview", { cache: "no-store" });
      const body = await response.json().catch(() => undefined) as
        (Overview & { error?: string }) | undefined;
      if (!response.ok) throw new Error(body?.error ?? "No se pudieron cargar los envíos AEAT.");
      if (!body || body.companyId !== companyId)
        throw new Error("Los envíos AEAT no corresponden a esta empresa.");
      return body;
    },
    refetchInterval: 30_000,
  });

  return (
    <section className="company-settings-card" aria-labelledby="sif-aeat-overview-title">
      <h2 id="sif-aeat-overview-title">Remisiones AEAT Pruebas</h2>
      <p>Estado de los envíos de esta empresa. Esta vista no modifica registros SIF ni reenvía datos.</p>
      {overview.isPending ? (
        <p aria-live="polite">Cargando remisiones AEAT…</p>
      ) : overview.error ? (
        <p className="form-error" role="alert">{overview.error.message}</p>
      ) : (
        <>
          <p role="status">
            {overview.data.counts.ACCEPTED} aceptados · {overview.data.counts.ACCEPTED_WITH_ERRORS} aceptados con errores · {overview.data.counts.REJECTED} rechazados · {overview.data.counts.PENDING + overview.data.counts.SENDING + overview.data.counts.RETRY} en cola · {overview.data.counts.UNKNOWN} inciertos · {overview.data.counts.FAILED} fallidos
          </p>
          {overview.data.attention.length === 0 ? (
            <p>Sin envíos inciertos, fallidos ni reintentos pendientes.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption>Envíos que requieren seguimiento: {overview.data.attention.length} de {overview.data.counts.UNKNOWN + overview.data.counts.FAILED + overview.data.counts.RETRY} más recientes</caption>
                <thead><tr><th scope="col">Factura</th><th scope="col">Posición SIF</th><th scope="col">Estado</th><th scope="col">Intentos</th><th scope="col">Próximo intento</th><th scope="col">Detalle</th></tr></thead>
                <tbody>
                  {overview.data.attention.map((item) => (
                    <tr key={item.id}>
                      <td><Link href={`/facturas/${item.invoiceId}`}>{item.invoiceNumber}</Link></td>
                      <td>{item.chainPosition}</td>
                      <td>{item.status === "UNKNOWN" ? "Incierto" : item.status === "FAILED" ? "Fallido" : "Reintento"}</td>
                      <td>{item.attempts}</td>
                      <td>{item.status === "FAILED" ? "Revisión necesaria" : new Date(item.availableAt).toLocaleString("es-ES")}</td>
                      <td>{item.lastError ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {overview.data.review.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <caption>Resultados con incidencias: {overview.data.review.length} de {overview.data.counts.ACCEPTED_WITH_ERRORS + overview.data.counts.REJECTED} más recientes. Incluye casos históricos con seguimiento.</caption>
                <thead><tr><th scope="col">Factura</th><th scope="col">Registro SIF</th><th scope="col">Respuesta AEAT</th><th scope="col">Incidencia</th><th scope="col">Seguimiento</th></tr></thead>
                <tbody>
                  {overview.data.review.map((item) => (
                    <tr key={item.id}>
                      <td><Link href={`/facturas/${item.invoiceId}#trazabilidad`}>{item.invoiceNumber}</Link></td>
                      <td>{recordTypeLabel(item.recordType)} · posición {item.chainPosition}</td>
                      <td>{outcomeLabel(item.status)}{item.csv ? ` · CSV ${item.csv}` : ""}</td>
                      <td>{item.errorCode ? `Código ${item.errorCode} · ` : ""}{item.errorDescription ?? item.lastError ?? item.recordStatus ?? "Sin detalle"}</td>
                      <td>
                        {item.reviewKind === "FOLLOW_UP_RECORDED"
                          ? item.followUps.map((followUp) => `${recordTypeLabel(followUp.recordType)} · posición ${followUp.chainPosition} · ${followUpLabel(followUp.status)}`).join("; ")
                          : item.reviewKind === "TIMESTAMP_SUBSANATION_CANDIDATE"
                            ? "Posible subsanación de fecha/hora: comprobar en la factura"
                            : item.reviewKind === "REJECTED_REGISTRATION_REVIEW"
                              ? "Revisar factura y causa del rechazo; recuperación disponible si los datos son correctos y la causa externa se resolvió"
                            : item.reviewKind === "GLOBAL_REJECTION_REVIEW"
                              ? "Revisión manual: sin respuesta definitiva del registro"
                              : "Revisión manual del caso"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {overview.data.review.length > 0 && <p>Un seguimiento registrado no implica por sí solo que la incidencia esté resuelta. Consulta la respuesta del nuevo registro en la factura.</p>}
          <p className="notice">Los estados inciertos se reintentan automáticamente con el XML congelado. Un fallo local o un duplicado no verificable requiere revisión antes de actuar manualmente.</p>
        </>
      )}
      <button className="secondary-button" disabled={overview.isFetching} onClick={() => void overview.refetch()} type="button">{overview.isFetching ? "Actualizando…" : "Actualizar envíos"}</button>
    </section>
  );
}

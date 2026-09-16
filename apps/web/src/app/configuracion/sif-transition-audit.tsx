"use client";

import { useQuery } from "@tanstack/react-query";

type AuditGroup = {
  sifMode: string;
  aeatEnvironment: string;
  recordType: string;
  softwareId: string | null;
  softwareIdValid: boolean;
  records: number;
  frozenXmlRecords: number;
  unavailableXmlRecords: number;
  legacyXmlRecords: number;
  firstPosition: string;
  lastPosition: string;
};

type TransitionAudit = {
  companyId: string;
  totalRecords: number;
  historicalChainReviewRequired: boolean;
  groups: AuditGroup[];
};

export function SifTransitionAudit({ companyId }: { companyId: string }) {
  const audit = useQuery({
    queryKey: ["sif-transition-audit", companyId],
    queryFn: async (): Promise<TransitionAudit> => {
      const response = await fetch("/api/sif/records/transition-audit", {
        cache: "no-store",
      });
      const body = await response.json().catch(() => undefined) as
        (TransitionAudit & { error?: string }) | undefined;
      if (!response.ok)
        throw new Error(body?.error ?? "No se pudo cargar el inventario SIF.");
      if (!body || body.companyId !== companyId)
        throw new Error("El inventario SIF no corresponde a esta empresa.");
      return body;
    },
  });

  return (
    <section className="company-settings-card" aria-labelledby="sif-audit-title">
      <h2 id="sif-audit-title">Inventario histórico SIF</h2>
      <p>Consulta los registros y metadatos conservados para esta empresa. Esta vista no modifica facturas ni cadenas SIF.</p>
      {audit.isPending ? (
        <p aria-live="polite">Cargando inventario SIF…</p>
      ) : audit.error ? (
        <p className="form-error" role="alert">{audit.error.message}</p>
      ) : (
        <>
          <p role="status">{audit.data.totalRecords} registros SIF · {audit.data.historicalChainReviewRequired ? "Revisión histórica necesaria" : "Sin registros históricos en esta base"}</p>
          {audit.data.groups.length > 0 && (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">Registros SIF históricos agrupados por modo, entorno, tipo e identificador de software</caption>
                <thead><tr><th scope="col">Modo y entorno</th><th scope="col">Tipo</th><th scope="col">Software</th><th scope="col">Registros</th><th scope="col">Posiciones</th><th scope="col">XML</th></tr></thead>
                <tbody>
                  {audit.data.groups.map((group) => (
                    <tr key={`${group.sifMode}:${group.aeatEnvironment}:${group.recordType}:${group.softwareId ?? "null"}`}>
                      <td><strong>{group.sifMode}</strong><small>{group.aeatEnvironment}</small></td>
                      <td>{group.recordType === "REGISTRATION" ? "Alta" : group.recordType === "CANCELLATION" ? "Anulación" : group.recordType}</td>
                      <td><strong>{group.softwareId ?? "Sin capturar"}</strong><small>{group.softwareIdValid ? "Formato válido" : "Formato no válido o ausente"}</small></td>
                      <td>{group.records}</td>
                      <td>{group.firstPosition}–{group.lastPosition}</td>
                      <td><strong>{group.frozenXmlRecords} congelados</strong><small>{group.unavailableXmlRecords} indisponibles · {group.legacyXmlRecords} anteriores al snapshot</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="notice">Este inventario no certifica conformidad ni autoriza a enlazar, descartar o reiniciar una cadena SIF. La verificación técnica de la cadena se consulta aparte.</p>
        </>
      )}
      <button className="secondary-button" disabled={audit.isFetching} onClick={() => void audit.refetch()} type="button">{audit.isFetching ? "Actualizando…" : "Actualizar inventario"}</button>
    </section>
  );
}

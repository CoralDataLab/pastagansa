"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AppShell, type SessionView } from "@/components/app-shell";
import {
  displayProposalValue,
  proposalRequest,
  type LearningCandidateStatus,
  type PurchaseProposalLearningCandidate,
  type PurchaseProposalLearningSummary,
} from "@/lib/purchase-proposals";

const statuses: Array<{ value: LearningCandidateStatus; label: string }> = [
  { value: "PENDING_REVIEW", label: "Pendientes" },
  { value: "APPROVED", label: "Aprobados" },
  { value: "REJECTED", label: "Rechazados" },
];

export function LearningCandidatesView() {
  const [status, setStatus] = useState<LearningCandidateStatus>("PENDING_REVIEW");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => proposalRequest<SessionView>("/api/auth/session"),
    retry: false,
  });
  const companyId = session.data?.membership.company.id;
  const canReview = !!session.data?.membership.role.permissions.includes(
    "command_proposal.review",
  );
  const capability = useQuery({
    queryKey: ["purchase-proposal-capabilities", companyId],
    queryFn: () =>
      proposalRequest<{ enabled: boolean }>("/api/purchase-proposals/capabilities"),
    enabled: canReview,
    retry: false,
  });
  const summary = useQuery({
    queryKey: ["purchase-proposal-learning-summary", companyId],
    queryFn: () =>
      proposalRequest<PurchaseProposalLearningSummary>(
        "/api/purchase-proposals/learning-candidates/summary",
      ),
    enabled: canReview && capability.data?.enabled === true,
    retry: false,
  });
  const candidates = useQuery({
    queryKey: ["purchase-proposal-learning", companyId, status],
    queryFn: () =>
      proposalRequest<PurchaseProposalLearningCandidate[]>(
        `/api/purchase-proposals/learning-candidates?status=${status}`,
      ),
    enabled: canReview && capability.data?.enabled === true,
    retry: false,
  });
  const decision = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: "approve" | "reject"; reason: string }) =>
      proposalRequest<PurchaseProposalLearningCandidate>(
        `/api/purchase-proposals/learning-candidates/${id}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["purchase-proposal-learning", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["purchase-proposal-learning-summary", companyId] });
    },
  });
  return (
    <AppShell active="compras">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Compras · Aprendizaje gobernado</p>
          <h1>Candidatos de aprendizaje</h1>
          <p>
            Revisa correcciones humanas antes de considerarlas conocimiento reutilizable.
            Aprobar un candidato no cambia reglas fiscales ni futuras propuestas automáticamente.
          </p>
        </div>
        <Link href="/compras/propuestas" className="secondary-button">
          Volver a revisión
        </Link>
      </section>
      {!canReview && session.data && (
        <p role="alert">Necesitas permiso de revisión para gestionar candidatos.</p>
      )}
      {canReview && capability.isPending && <p role="status">Comprobando disponibilidad…</p>}
      {capability.data?.enabled === false && (
        <p role="status">La revisión supervisada está desactivada en esta API.</p>
      )}
      {capability.data?.enabled && (
        <section className="data-panel">
          {summary.data && (
            <dl className="proposal-summary">
              <div><dt>Pendientes</dt><dd>{summary.data.pendingReview}</dd></div>
              <div><dt>Aprobados</dt><dd>{summary.data.approved}</dd></div>
              <div><dt>Rechazados</dt><dd>{summary.data.rejected}</dd></div>
            </dl>
          )}
          {summary.error && <p role="alert">No se pudo cargar el resumen: {summary.error.message}</p>}
          <div className="data-toolbar">
            <div>
              <h2>Correcciones candidatas</h2>
              <p>Últimos 100 candidatos del estado seleccionado.</p>
            </div>
            <label className="filter-field">
              <span>Estado</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as LearningCandidateStatus)}>
                {statuses.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <button onClick={() => { void candidates.refetch(); void summary.refetch(); }}>Actualizar</button>
          </div>
          {candidates.isPending && <p role="status">Cargando candidatos…</p>}
          {candidates.error && <p role="alert">{candidates.error.message}</p>}
          {decision.error && <p role="alert">{decision.error.message}</p>}
          {candidates.data?.length === 0 && <p>No hay candidatos en este estado.</p>}
          {!!candidates.data?.length && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Corrección</th>
                    <th>Propuesta</th>
                    <th>Decisión</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.data.map((candidate) => {
                    const reason = reasonById[candidate.id] ?? "";
                    return (
                      <tr key={candidate.id}>
                        <td>
                          {candidate.fieldPath}
                          <small>{candidate.commandName} v{candidate.commandVersion}</small>
                        </td>
                        <td>
                          <small>Antes: {displayProposalValue(candidate.originalValue)}</small>
                          <small>Después: {displayProposalValue(candidate.correctedValue)}</small>
                        </td>
                        <td>
                          <Link className="table-link" href={`/compras/propuestas/${candidate.proposalId}`}>
                            Abrir propuesta
                          </Link>
                          <small>{new Date(candidate.createdAt).toLocaleString("es-ES")}</small>
                        </td>
                        <td>
                          {candidate.status === "PENDING_REVIEW" ? (
                            <div className="stacked-actions">
                              <input
                                aria-label={`Motivo para ${candidate.fieldPath}`}
                                value={reason}
                                onChange={(event) => setReasonById({ ...reasonById, [candidate.id]: event.target.value })}
                                placeholder="Motivo de revisión"
                              />
                              <button
                                disabled={decision.isPending || !reason.trim()}
                                onClick={() => decision.mutate({ id: candidate.id, action: "approve", reason })}
                              >
                                Aprobar
                              </button>
                              <button
                                disabled={decision.isPending || !reason.trim()}
                                onClick={() => decision.mutate({ id: candidate.id, action: "reject", reason })}
                              >
                                Rechazar
                              </button>
                            </div>
                          ) : (
                            <>
                              {candidate.status}
                              <small>{candidate.reviewReason}</small>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}

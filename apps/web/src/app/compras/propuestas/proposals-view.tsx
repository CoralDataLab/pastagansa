"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AppShell, type SessionView } from "@/components/app-shell";
import {
  proposalRequest,
  proposalStatusLabel,
  type ProposalStatus,
  type PurchaseProposal,
} from "@/lib/purchase-proposals";

export function PurchaseProposalsView() {
  const [status, setStatus] = useState<ProposalStatus | "">("PENDING_REVIEW");
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => proposalRequest<SessionView>("/api/auth/session"),
    retry: false,
  });
  const companyId = session.data?.membership.company.id;
  const canRead = !!session.data?.membership.role.permissions.includes(
    "command_proposal.read",
  );
  const capability = useQuery({
    queryKey: ["purchase-proposal-capabilities", companyId],
    queryFn: () =>
      proposalRequest<{ enabled: boolean }>(
        "/api/purchase-proposals/capabilities",
      ),
    enabled: canRead,
    retry: false,
  });
  const proposals = useQuery({
    queryKey: ["purchase-proposals", companyId, status],
    queryFn: () =>
      proposalRequest<PurchaseProposal[]>(
        `/api/purchase-proposals?limit=100${status ? `&status=${status}` : ""}`,
      ),
    enabled: canRead && capability.data?.enabled === true,
    retry: false,
  });
  return (
    <AppShell active="compras">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Compras · Revisión supervisada</p>
          <h1>Propuestas de compra</h1>
          <p>
            Revisar una propuesta crea solo un borrador. La aprobación de la
            compra es un paso separado.
          </p>
        </div>
        <Link href="/compras" className="secondary-button">
          Volver a compras
        </Link>
      </section>
      {!canRead && session.data && (
        <p role="alert">No tienes permiso para leer propuestas.</p>
      )}
      {canRead && capability.isPending && (
        <p role="status">Comprobando disponibilidad…</p>
      )}
      {capability.error && (
        <p role="alert">
          {capability.error.message}{" "}
          <button onClick={() => void capability.refetch()}>Reintentar</button>
        </p>
      )}
      {capability.data?.enabled === false && (
        <p role="status">
          El piloto de propuestas está desactivado en esta API.
        </p>
      )}
      {capability.data?.enabled && (
        <section className="data-panel" aria-labelledby="proposals-title">
          <div className="data-toolbar">
            <div>
              <h2 id="proposals-title">Bandeja de revisión</h2>
              <p>
                Últimas 100 propuestas del filtro seleccionado; sin paginación.
              </p>
            </div>
            <label className="filter-field">
              <span>Estado</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as ProposalStatus | "")
                }
              >
                <option value="PENDING_REVIEW">Pendientes de revisión</option>
                <option value="EXECUTED">Borradores creados</option>
                <option value="REJECTED">Rechazadas</option>
                <option value="">Todos</option>
              </select>
            </label>
            <button onClick={() => void proposals.refetch()}>Actualizar</button>
          </div>
          {proposals.isPending && <p role="status">Cargando propuestas…</p>}
          {proposals.error && <p role="alert">{proposals.error.message}</p>}
          {proposals.data?.length === 0 && (
            <p>No hay propuestas en este estado.</p>
          )}
          {!!proposals.data?.length && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Documento</th>
                    <th>Origen declarado</th>
                    <th>Creada</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.data.map((proposal) => (
                    <tr key={proposal.id}>
                      <td>
                        <Link
                          className="table-link"
                          href={`/compras/propuestas/${proposal.id}`}
                        >
                          {proposal.payload.supplierInvoiceNumber}
                        </Link>
                        <small>{proposal.commandId}</small>
                      </td>
                      <td>
                        {proposal.provenance.channel}
                        <small>
                          {proposal.provenance.agentId ??
                            "Sin agente declarado"}
                        </small>
                      </td>
                      <td>
                        {new Date(proposal.createdAt).toLocaleString("es-ES")}
                      </td>
                      <td>{proposalStatusLabel(proposal.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}

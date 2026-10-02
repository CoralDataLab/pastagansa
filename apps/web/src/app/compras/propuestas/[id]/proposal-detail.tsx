"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { Contact, ContactPage } from "@/lib/contacts";
import { AppShell, type SessionView } from "@/components/app-shell";
import {
  assignProposalSchema,
  displayProposalValue,
  executeProposalSchema,
  payloadChanges,
  proposalRequest,
  proposalStatusLabel,
  rejectProposalSchema,
  type ProposalPayload,
  type PurchaseProposal,
  type PurchaseProposalAssignee,
  type PurchaseProposalProjection,
} from "@/lib/purchase-proposals";

type Field = {
  key: string;
  label: string;
  numeric?: boolean;
  required?: boolean;
};
const headerFields: Field[] = [
  {
    key: "supplierInvoiceNumber",
    label: "Número de factura del proveedor",
    required: true,
  },
  { key: "issueDate", label: "Fecha de emisión", required: true },
  { key: "receivedDate", label: "Fecha de recepción", required: true },
  { key: "operationDate", label: "Fecha de operación" },
  { key: "deductionDate", label: "Fecha de deducción" },
  { key: "dueDate", label: "Vencimiento" },
  { key: "currency", label: "Moneda (código ISO)" },
  { key: "withholdingRate", label: "Retención IRPF (%)", numeric: true },
  { key: "notes", label: "Notas" },
];
const lineFields: Field[] = [
  { key: "description", label: "Descripción", required: true },
  { key: "quantity", label: "Cantidad", numeric: true, required: true },
  { key: "unitPrice", label: "Precio unitario", numeric: true, required: true },
  { key: "discountPct", label: "Descuento (%)", numeric: true },
  { key: "taxRate", label: "IVA (%)", numeric: true },
  { key: "deductiblePct", label: "Deducción (%)", numeric: true },
  { key: "taxRuleId", label: "ID regla fiscal" },
  { key: "catalogItemId", label: "ID artículo de catálogo" },
  { key: "exemptionReason", label: "Motivo de exención" },
];
function Fields({
  fields,
  value,
  onChange,
}: {
  fields: Field[];
  value: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="proposal-form-grid">
      {fields.map((field) => (
        <label key={field.key}>
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
          <input
            type={field.numeric ? "number" : "text"}
            step="any"
            value={
              typeof value[field.key] === "number" &&
              !Number.isFinite(value[field.key])
                ? ""
                : String(value[field.key] ?? "")
            }
            onChange={(event) =>
              onChange(
                field.key,
                event.target.value === ""
                  ? field.required && field.numeric
                    ? NaN
                    : field.required
                      ? ""
                      : undefined
                  : field.numeric
                    ? Number(event.target.value)
                    : event.target.value,
              )
            }
          />
        </label>
      ))}
    </div>
  );
}

export function PurchaseProposalDetail({ id }: { id: string }) {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => proposalRequest<SessionView>("/api/auth/session"),
    retry: false,
  });
  const companyId = session.data?.membership.company.id;
  const permissions = session.data?.membership.role.permissions ?? [];
  const canRead = permissions.includes("command_proposal.read");
  const capability = useQuery({
    queryKey: ["purchase-proposal-capabilities", companyId],
    queryFn: () =>
      proposalRequest<{ enabled: boolean }>(
        "/api/purchase-proposals/capabilities",
      ),
    enabled: canRead,
    retry: false,
  });
  const proposal = useQuery({
    queryKey: ["purchase-proposal", companyId, id],
    queryFn: () =>
      proposalRequest<PurchaseProposal>(`/api/purchase-proposals/${id}`),
    enabled: canRead && capability.data?.enabled === true,
    retry: false,
  });
  return (
    <AppShell active="compras">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Compras · Revisión supervisada</p>
          <h1>Revisar factura recibida</h1>
          <p>
            Revisa el documento, comprueba los datos y decide si crear un borrador.
            Este paso no aprueba gastos, no contabiliza ni envía a la AEAT.
          </p>
        </div>
        <Link href="/compras/propuestas" className="secondary-button">
          Volver a la bandeja
        </Link>
      </section>
      {!canRead && session.data && (
        <p role="alert">No tienes permiso para leer propuestas.</p>
      )}
      {capability.data?.enabled === false && (
        <p role="status">El piloto está desactivado en esta API.</p>
      )}
      {canRead &&
        (capability.isPending ||
          (capability.data?.enabled && proposal.isPending)) && (
          <p role="status">Cargando propuesta…</p>
        )}
      {(capability.error || proposal.error) && (
        <p role="alert">
          {(capability.error || proposal.error)?.message}{" "}
          <button
            onClick={() => {
              void capability.refetch();
              void proposal.refetch();
            }}
          >
            Reintentar
          </button>
        </p>
      )}
      {proposal.data && capability.data?.enabled && (
        <Review
          key={`${companyId}:${id}`}
          proposal={proposal.data}
          companyId={companyId!}
          canAssign={permissions.includes("command_proposal.review")}
          canReject={permissions.includes("command_proposal.review")}
          canExecute={
            permissions.includes("command_proposal.review") &&
            permissions.includes("purchase_invoice.create")
          }
          canAttach={
            permissions.includes("command_proposal.create") &&
            permissions.includes("command_proposal.read")
          }
        />
      )}
    </AppShell>
  );
}

function Review({
  proposal,
  companyId,
  canAssign,
  canReject,
  canExecute,
  canAttach,
}: {
  proposal: PurchaseProposal;
  companyId: string;
  canAssign: boolean;
  canReject: boolean;
  canExecute: boolean;
  canAttach: boolean;
}) {
  const client = useQueryClient();
  const [payload, setPayload] = useState<ProposalPayload>(() =>
    structuredClone(proposal.payload),
  );
  const [reason, setReason] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [assignmentReason, setAssignmentReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState("");
  const [notice, setNotice] = useState("");
  const changes = payloadChanges(proposal.payload, payload);
  const suppliers = useQuery({
    queryKey: ["purchase-proposal-suppliers", companyId],
    queryFn: async () => {
      const contacts: Contact[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ kind: "SUPPLIER", limit: "50" });
        if (cursor) params.set("cursor", cursor);
        const page = await proposalRequest<ContactPage>(`/api/contacts?${params}`);
        contacts.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return contacts;
    },
    retry: false,
  });
  const supplierName = (id: string) =>
    suppliers.data?.find((supplier) => supplier.id === id)?.legalName ??
    (suppliers.isPending ? "Cargando proveedor…" : `Proveedor no disponible (${id})`);
  const projection = useQuery({
    queryKey: ["purchase-proposal-projection", companyId, proposal.id],
    queryFn: () =>
      proposalRequest<PurchaseProposalProjection>(
        `/api/purchase-proposals/${proposal.id}/projection`,
      ),
    retry: false,
  });
  const assignees = useQuery({
    queryKey: ["purchase-proposal-assignees", companyId],
    queryFn: () =>
      proposalRequest<PurchaseProposalAssignee[]>(
        "/api/purchase-proposals/assignees",
      ),
    enabled: canAssign && proposal.status === "PENDING_REVIEW",
    retry: false,
  });
  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.set("file", file, file.name);
      return proposalRequest(`/api/purchase-proposals/${proposal.id}/documents`, {
        method: "POST",
        body,
      });
    },
    onSuccess: async () => {
      setNotice("Documento custodiado en la propuesta.");
      await client.invalidateQueries({
        queryKey: ["purchase-proposal", companyId, proposal.id],
      });
    },
  });
  const mutation = useMutation({
    mutationFn: ({
      action,
      body,
    }: {
      action: "assign" | "execute" | "reject";
      body: unknown;
    }) =>
      proposalRequest<PurchaseProposal>(
        `/api/purchase-proposals/${proposal.id}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: async (result) => {
      client.setQueryData(
        ["purchase-proposal", companyId, proposal.id],
        result,
      );
      setNotice(
        result.status === "EXECUTED"
          ? "Borrador creado. La aprobación de compras sigue pendiente."
          : result.status === "REJECTED"
            ? "Propuesta rechazada. No se ha creado ninguna compra."
            : "Propuesta asignada para revisión.",
      );
      await client.invalidateQueries({
        queryKey: ["purchase-proposals", companyId],
      });
      await client.invalidateQueries({ queryKey: ["purchases"] });
      await client.invalidateQueries({
        queryKey: ["purchase-proposal-projection", companyId, proposal.id],
      });
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ["purchase-proposal", companyId, proposal.id],
      });
      void client.invalidateQueries({
        queryKey: ["purchase-proposal-projection", companyId, proposal.id],
      });
    },
  });
  function edit(key: string, value: unknown, index?: number) {
    setConfirmed(false);
    setValidation("");
    mutation.reset();
    setPayload((current) =>
      index === undefined
        ? { ...current, [key]: value }
        : {
            ...current,
            lines: current.lines.map((line, i) =>
              i === index ? { ...line, [key]: value } : line,
            ),
          },
    );
  }
  function assign() {
    setValidation("");
    const result = assignProposalSchema.safeParse({
      assignedToId,
      reason: assignmentReason,
    });
    if (!result.success) {
      setValidation(
        result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" · "),
      );
      return;
    }
    mutation.mutate({ action: "assign", body: result.data });
  }

  function decide(action: "execute" | "reject") {
    setValidation("");
    if (action === "execute" && !confirmed) {
      setValidation(
        "Confirma que has contrastado el documento y las correcciones.",
      );
      return;
    }
    const schema =
      action === "execute" ? executeProposalSchema : rejectProposalSchema;
    const result = schema.safeParse(
      action === "execute" ? { reason, payload } : { reason },
    );
    if (!result.success) {
      setValidation(
        result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" · "),
      );
      return;
    }
    mutation.mutate({ action, body: result.data });
  }
  return (
    <div className="proposal-workspace">
      <aside className="proposal-guide">
        <strong>Cómo funciona esta revisión</strong>
        <ol>
          <li>Contrasta el documento original.</li>
          <li>Revisa el proveedor y corrige los datos si hace falta.</li>
          <li>Crea un borrador o rechaza el registro propuesto.</li>
        </ol>
        <p>Estos datos son una propuesta de registro de factura, no una solicitud de compra. Crear el borrador es el primer paso;
          la aprobación y contabilización se realizan después en Compras.</p>
        <p>La procedencia es declarada: esta pantalla no extrae datos automáticamente ni demuestra que una IA haya intervenido.</p>
      </aside>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className="data-panel">
        <h2>1. Factura y datos recibidos · {proposalStatusLabel(proposal.status)}</h2>
        <dl className="proposal-summary">
          <div><dt>Proveedor</dt><dd>{supplierName(proposal.payload.supplierId)}</dd></div>
          <div><dt>Factura del proveedor</dt><dd>{proposal.payload.supplierInvoiceNumber}</dd></div>
          <div><dt>Fecha de emisión</dt><dd>{proposal.payload.issueDate.slice(0, 10)}</dd></div>
          <div><dt>Líneas propuestas</dt><dd>{proposal.payload.lines.length}</dd></div>
        </dl>
        <details className="proposal-technical">
          <summary>Información técnica del original (solo lectura)</summary>
        <p>
          {proposal.commandId} · {proposal.name} v{proposal.version}
        </p>
        <p>
          Proponente: {proposal.proposedById} ·{" "}
          {new Date(proposal.createdAt).toLocaleString("es-ES")}
        </p>
        <p>
          Origen declarado: {proposal.provenance.channel} · Agente:{" "}
          {proposal.provenance.agentId ?? "No indicado"} · Versión:{" "}
          {proposal.provenance.agentVersion ?? "No indicada"}
        </p>
        <details>
          <summary>Datos originales inmutables</summary>
          <pre className="proposal-json">
            {JSON.stringify(proposal.payload, null, 2)}
          </pre>
        </details>
        </details>
        <h3>Referencias del documento</h3>
        <p>
          Las referencias externas son declarativas. Los documentos custodiados
          abajo sí se sirven desde esta propuesta tras comprobar su hash.
        </p>
        {proposal.evidence.length === 0 ? (
          <p>
            Sin evidencias adjuntas. Solicita el documento original antes de
            registrar.
          </p>
        ) : (
          <ul>
            {proposal.evidence.map((evidence, index) => (
              <li key={index}>
                <strong>{evidence.description ?? "Referencia"}</strong>
                <pre className="proposal-json">
                  {evidence.reference}
                  {evidence.sha256
                    ? `\nSHA-256 declarado: ${evidence.sha256}`
                    : ""}
                </pre>
              </li>
            ))}
          </ul>
        )}
        <h3>Documento original adjunto</h3>
        {proposal.status === "PENDING_REVIEW" && canAttach && (
          <label className="secondary-button upload-button">
            {uploadMutation.isPending ? "Subiendo…" : "Adjuntar PDF/imagen"}
            <input
              className="sr-only"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              disabled={uploadMutation.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) uploadMutation.mutate(file);
              }}
            />
          </label>
        )}
        {uploadMutation.error && (
          <p role="alert">{uploadMutation.error.message}</p>
        )}
        {proposal.documents?.length ? (
          <ul>
            {proposal.documents.map((document) => (
              <li key={document.id}>
                <a
                  href={`/api/purchase-proposals/${proposal.id}/documents/${document.id}/download`}
                >
                  {document.originalName}
                </a>{" "}
                · {(document.sizeBytes / 1024).toFixed(1)} KiB
                <details><summary>Huella de integridad</summary><code>{document.sha256}</code></details>
              </li>
            ))}
          </ul>
        ) : (
          <p>Sin documentos custodiados en esta propuesta.</p>
        )}
        <details className="proposal-technical">
          <summary>Historial e información técnica (eventos e integridad)</summary>
        <h3>Proyección contrastada</h3>
        {projection.data ? (
          <div>
            <p>
              Cadena {projection.data.chainValid ? "válida" : "alterada"} · {" "}
              {projection.data.eventCount} eventos · {" "}
              {projection.data.matchesCurrentState
                ? "coincide con el estado actual"
                : "no coincide con las tablas actuales"}
            </p>
            <p>
              Proyectado: {projection.data.projected.status} · Asignado: {" "}
              {projection.data.projected.currentAssigneeId ?? "Sin asignar"} · {" "}
              Correcciones: {projection.data.projected.correctionCount} · {" "}
              Documentos: {projection.data.projected.documentCount} · {" "}
              Intentos fallidos: {projection.data.projected.failedAttemptCount}
            </p>
            <p>
              Proyección materializada: {projection.data.materialized ? "disponible" : "no disponible"}
              {projection.data.materialized
                ? ` · secuencia ${projection.data.materialized.lastEventSequence}`
                : ""}
            </p>
            {projection.data.discrepancies.length > 0 && (
              <ul>
                {projection.data.discrepancies.map((discrepancy) => (
                  <li key={discrepancy}>{discrepancy}</li>
                ))}
              </ul>
            )}
          </div>
        ) : projection.error ? (
          <p role="alert">No se pudo contrastar la proyección: {projection.error.message}</p>
        ) : (
          <p>Contrastando proyección…</p>
        )}
        <h3>Eventos reconstruibles</h3>
        {proposal.events?.length ? (
          <ol>
            {proposal.events.map((event) => (
              <li key={event.id}>
                #{event.sequence} · {event.type} · {event.actorUserId} · {" "}
                {new Date(event.occurredAt).toLocaleString("es-ES")}
                <pre className="proposal-json">
                  Hash: {event.eventHash}
                  {event.previousEventHash
                    ? `\nAnterior: ${event.previousEventHash}`
                    : "\nInicio de cadena"}
                </pre>
              </li>
            ))}
          </ol>
        ) : (
          <p>Sin eventos reconstruibles registrados.</p>
        )}
        <h3>Asignación del expediente</h3>
        {proposal.assignments?.length ? (
          <ul>
            {proposal.assignments.map((assignment, index) => (
              <li key={assignment.id}>
                {index === 0 ? "Actual: " : "Anterior: "}
                {assignment.assignedToId} · asignado por {assignment.assignedById} · {" "}
                {new Date(assignment.assignedAt).toLocaleString("es-ES")} · {" "}
                {assignment.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p>Sin responsable asignado.</p>
        )}
        <h3>Intentos fallidos</h3>
        {proposal.attempts?.length ? (
          <ul>
            {proposal.attempts.map((attempt) => (
              <li key={attempt.id}>
                {attempt.attemptedById} · {" "}
                {new Date(attempt.attemptedAt).toLocaleString("es-ES")} · {" "}
                {attempt.reason} · Código: {attempt.errorCode}
                <pre className="proposal-json">{attempt.errorMessage}</pre>
              </li>
            ))}
          </ul>
        ) : (
          <p>Sin intentos fallidos persistidos.</p>
        )}
        <h3>Correcciones conservadas</h3>
        {proposal.revisions?.length ? (
          <ul>
            {proposal.revisions.map((revision) => (
              <li key={revision.id}>
                Revisión {revision.revisionNumber} · {revision.createdById} · {" "}
                {new Date(revision.createdAt).toLocaleString("es-ES")} · {" "}
                {revision.changes.map((change) => change.path).join(", ")}
              </li>
            ))}
          </ul>
        ) : (
          <p>Sin correcciones persistidas por campo.</p>
        )}
        </details>
      </section>
      {proposal.review && (
        <section className="data-panel">
          <h2>Resultado de la revisión</h2>
          <p>{proposal.status === "EXECUTED"
            ? "Se creó un borrador de compra con los datos aceptados. Esta revisión no aprobó el gasto ni lo contabilizó. Consulta la compra para ver su estado actual."
            : "La propuesta fue rechazada. Esta decisión no creó ninguna compra."}</p>
          <p>
            {proposalStatusLabel(proposal.status)} · Revisor:{" "}
            {proposal.review.reviewedById} ·{" "}
            {new Date(proposal.review.reviewedAt).toLocaleString("es-ES")}
          </p>
          <p>{proposal.review.reason}</p>
          {proposal.review.acceptedPayload && (
            <>
              <details className="proposal-technical">
                <summary>Datos aceptados (información técnica)</summary>
                <pre className="proposal-json">
                  {JSON.stringify(proposal.review.acceptedPayload, null, 2)}
                </pre>
              </details>
              <Diff
                before={proposal.payload}
                after={proposal.review.acceptedPayload}
              />
            </>
          )}
          {proposal.execution?.result.id && (
            <Link
              className="primary-button compact"
              href={`/compras/${proposal.execution.result.id}`}
            >
              Abrir compra creada (estado actual)
            </Link>
          )}
        </section>
      )}
      {proposal.status === "PENDING_REVIEW" && (
        <section className="data-panel">
          <h2>2. Revisa los datos propuestos</h2>
          <p>
            Las correcciones se conservarán aparte del original. Las reglas
            fiscales definitivas se validan en el servidor al crear el borrador;
            no se muestran totales estimados.
          </p>
          {canAssign && (
            <fieldset
              disabled={mutation.isPending}
              className="proposal-fieldset"
            >
              <legend>Asignar responsable</legend>
              <label>
                Usuario responsable
                <select
                  value={assignedToId}
                  disabled={assignees.isPending || !!assignees.error}
                  onChange={(event) => setAssignedToId(event.target.value)}
                >
                  <option value="">Selecciona un usuario activo</option>
                  {assignees.data?.map((assignee) => (
                    <option key={assignee.id} value={assignee.id}>
                      {assignee.email} · {assignee.roleName}
                    </option>
                  ))}
                </select>
              </label>
              {assignees.error && (
                <p role="alert">
                  No se pudieron cargar usuarios asignables: {assignees.error.message}
                </p>
              )}
              <label className="proposal-reason">
                Motivo de asignación
                <textarea
                  maxLength={1000}
                  value={assignmentReason}
                  onChange={(event) => setAssignmentReason(event.target.value)}
                />
              </label>
              <button type="button" onClick={assign}>
                Asignar expediente
              </button>
            </fieldset>
          )}
          {!canExecute && (
            <p>
              No tienes permisos para crear el borrador desde esta propuesta.
            </p>
          )}
          {canExecute && (
            <fieldset
              disabled={mutation.isPending}
              className="proposal-fieldset"
            >
              <legend>Datos del borrador de compra</legend>
              <label className="proposal-supplier">
                Proveedor *
                <select
                  aria-label="Proveedor *"
                  value={payload.supplierId}
                  disabled={suppliers.isPending || !!suppliers.error}
                  onChange={(event) => edit("supplierId", event.target.value)}
                >
                  {!suppliers.data?.some((supplier) => supplier.id === payload.supplierId) && (
                    <option value={payload.supplierId}>{supplierName(payload.supplierId)}</option>
                  )}
                  {suppliers.data?.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.legalName}{supplier.taxId ? ` · ${supplier.taxId}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {suppliers.error && <p role="alert">No se pudo cargar el nombre del proveedor. Los datos originales se conservan. {suppliers.error.message}</p>}
              <Fields
                fields={headerFields}
                value={payload}
                onChange={(key, value) => edit(key, value)}
              />
              {payload.lines.map((line, index) => (
                <fieldset key={index} className="proposal-fieldset">
                  <legend>Línea {index + 1}</legend>
                  <Fields
                    fields={lineFields}
                    value={line}
                    onChange={(key, value) => edit(key, value, index)}
                  />
                  <label>
                    Cuenta de gasto
                    <select
                      value={line.expenseAccountCode ?? ""}
                      onChange={(event) =>
                        edit(
                          "expenseAccountCode",
                          event.target.value || undefined,
                          index,
                        )
                      }
                    >
                      <option value="">Automática</option>
                      <option value="600000">600000 · Compras</option>
                      <option value="623000">623000 · Profesionales</option>
                      <option value="629000">629000 · Otros servicios</option>
                    </select>
                  </label>
                  {(
                    ["isDisbursement", "isEuServiceReverseCharge"] as const
                  ).map((key) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={line[key] ?? false}
                        onChange={(event) =>
                          edit(key, event.target.checked, index)
                        }
                      />
                      {key === "isDisbursement"
                        ? "Suplido"
                        : "Servicio UE con inversión del sujeto pasivo"}
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={payload.lines.length <= 1}
                    onClick={() => {
                      setConfirmed(false);
                      setPayload({
                        ...payload,
                        lines: payload.lines.filter((_, i) => i !== index),
                      });
                    }}
                  >
                    Eliminar línea {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                disabled={payload.lines.length >= 200}
                onClick={() => {
                  setConfirmed(false);
                  setPayload({
                    ...payload,
                    lines: [
                      ...payload.lines,
                      {
                        description: "",
                        quantity: 1,
                        unitPrice: 0,
                        deductiblePct: 100,
                      },
                    ],
                  });
                }}
              >
                Añadir línea
              </button>
              <Diff before={proposal.payload} after={payload} />
            </fieldset>
          )}
          {(canExecute || canReject) && (
            <>
              <h3>3. Decide qué hacer</h3>
              <p>Crear un borrador guarda una compra pendiente de su flujo habitual.
                Rechazar conserva los datos recibidos y el motivo, pero no registra la factura como compra.</p>
              <label className="proposal-reason">
                Motivo obligatorio
                <textarea
                  maxLength={1000}
                  value={reason}
                  disabled={mutation.isPending}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {canExecute && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={mutation.isPending}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  He contrastado el documento original y los datos que crearán
                  el borrador
                  {changes.length ? ` (${changes.length} cambios)` : ""}.
                </label>
              )}
              {validation && (
                <p className="inline-error" role="alert">
                  {validation}
                </p>
              )}
              {mutation.error && (
                <p className="inline-error" role="alert">
                  {mutation.error.message} Consulta el estado actualizado antes
                  de reintentar; se conserva tu revisión para repetir la misma
                  decisión.
                </p>
              )}
              <div className="dialog-actions">
                {canReject && (
                  <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => decide("reject")}
                  >
                    Rechazar propuesta
                  </button>
                )}
                {canExecute && (
                  <button
                    type="button"
                    className="primary-button compact"
                    disabled={mutation.isPending || !confirmed}
                    onClick={() => decide("execute")}
                  >
                    {mutation.isPending
                      ? "Guardando decisión…"
                      : "Crear solo borrador"}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
function Diff({
  before,
  after,
}: {
  before: ProposalPayload;
  after: ProposalPayload;
}) {
  const changes = payloadChanges(before, after);
  return (
    <div>
      <h3>Diferencias respecto al original</h3>
      {changes.length === 0 ? (
        <p>Sin correcciones.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Campo (líneas desde 0)</th>
                <th>Original</th>
                <th>Revisado</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.path}>
                  <td>{change.path}</td>
                  <td>{displayProposalValue(change.before)}</td>
                  <td>{displayProposalValue(change.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

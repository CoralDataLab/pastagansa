"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CommercialTimeline } from "@/components/commercial-timeline";
import { PaymentReminderDialog } from "@/components/payment-reminder-dialog";
import { formatMoney } from "@/lib/catalog";
import {
  deliveryRetryStorageKey,
  reusableDeliveryKey,
} from "@/lib/delivery-retry";
import {
  formatInvoiceDate,
  invoiceEmailKey,
  invoiceIssueKey,
  invoiceStatusLabel,
  paymentKey,
  paymentMethodLabel,
  todayIso,
  type DocumentSequence,
  type Invoice,
  type InvoiceEmailCapability,
  type InvoiceEmailDelivery,
  type InvoiceEmailInput,
  type InvoiceInput,
  type InvoiceTrace,
  type Payment,
  type PaymentInput,
  type PaymentInstallment,
  type RectificationInput,
  sifInvoiceTypeLabel,
} from "@/lib/invoices";
import { InvoiceDialog } from "../invoices-view";
import { quoteCode } from "@/lib/quotes";

export function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [rectifying, setRectifying] = useState(false);
  const [notice, setNotice] = useState("");
  const invoice = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => requestJson<Invoice>(`/api/invoices/${id}`),
    retry: false,
  });
  const updateInvoice = useMutation({
    mutationFn: (payload: InvoiceInput) =>
      requestJson<Invoice>(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["invoice", id], updated);
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      setEditing(false);
      setNotice("Los cambios del borrador se han guardado.");
    },
  });
  const createRectification = useMutation({
    mutationFn: (payload: RectificationInput) =>
      requestJson<Invoice>(`/api/invoices/${id}/rectifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      router.push(`/facturas/${created.id}`);
    },
  });

  if (invoice.isPending)
    return (
      <AppShell active="facturas">
        <section className="detail-loading" aria-live="polite">
          <div className="spinner" />
          <p>Cargando factura…</p>
        </section>
      </AppShell>
    );
  if (invoice.error)
    return (
      <AppShell active="facturas">
        <section className="detail-error">
          <p className="eyebrow">No se pudo abrir</p>
          <h1>Factura no disponible</h1>
          <p>{invoice.error.message}</p>
          <Link className="primary-link" href="/facturas">
            Volver a facturas
          </Link>
        </section>
      </AppShell>
    );

  const document = invoice.data;
  return (
    <AppShell active="facturas">
      <section className="detail-heading">
        <div>
          <Link className="back-link" href="/facturas">
            ← Facturas
          </Link>
          <p className="eyebrow">Documento de venta</p>
          <h1>{document.fullNumber ?? "Factura en borrador"}</h1>
          <p>{document.customerLegalName}</p>
        </div>
        <div className="detail-actions">
          {document.status === "DRAFT" ? (
            <>
              {document.documentType === "INVOICE" && (
                <button
                  className="secondary-button"
                  onClick={() => setEditing(true)}
                >
                  Editar borrador
                </button>
              )}
              <button
                className="primary-button compact"
                onClick={() => setIssuing(true)}
              >
                {document.documentType === "CREDIT_NOTE"
                  ? "Emitir rectificativa"
                  : "Emitir factura"}
              </button>
            </>
          ) : (
            <>
              {document.documentType === "INVOICE" &&
                document.status !== "RECTIFIED" &&
                document.status !== "CANCELLED" && (
                  <button
                    className="secondary-button"
                    onClick={() => setRectifying(true)}
                  >
                    Rectificar factura
                  </button>
                )}
              <a className="secondary-button trace-link" href="#trazabilidad">
                Ver trazabilidad
              </a>
              <a
                className="primary-link compact"
                href={`/api/invoices/${id}/pdf`}
                download
              >
                Descargar PDF
              </a>
            </>
          )}
        </div>
      </section>
      {document.documentType === "CREDIT_NOTE" && (
        <section className="invoice-summary-grid" aria-label="Rectificación">
          <article className="summary-card">
            <span>Clasificación AEAT</span>
            <strong>{document.sifInvoiceType}</strong>
          </article>
          <article className="summary-card">
            <span>Factura rectificada</span>
            <strong>{document.originalInvoice?.fullNumber ?? "—"}</strong>
          </article>
          <article className="summary-card total-card">
            <span>Motivo</span>
            <strong>{sifInvoiceTypeLabel(document.sifInvoiceType)}</strong>
          </article>
        </section>
      )}
      {document.sourceQuote && (
        <div className="notice" role="status">
          <span>↗</span>
          Creada desde el presupuesto
          <Link href={`/presupuestos/${document.sourceQuote.id}`}>
            {quoteCode(document.sourceQuote.code)}
          </Link>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          <span>✓</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      <section className="invoice-summary-grid">
        <article className="summary-card">
          <span>Estado</span>
          <strong>{invoiceStatusLabel(document.status)}</strong>
        </article>
        <article className="summary-card">
          <span>Fecha de emisión</span>
          <strong>{formatInvoiceDate(document.issueDate)}</strong>
        </article>
        {document.operationDate && document.operationDate.slice(0, 10) !== document.issueDate.slice(0, 10) && (
          <article className="summary-card">
            <span>Fecha de operación</span>
            <strong>{formatInvoiceDate(document.operationDate)}</strong>
          </article>
        )}
        <article className="summary-card">
          <span>Vencimiento</span>
          <strong>{formatInvoiceDate(document.dueDate)}</strong>
        </article>
        <article className="summary-card total-card">
          <span>Total</span>
          <strong>{formatMoney(document.total, document.currency)}</strong>
        </article>
        <article className="summary-card">
          <span>Cobrado</span>
          <strong>{formatMoney(document.amountPaid, document.currency)}</strong>
        </article>
        <article className="summary-card due-card">
          <span>Pendiente</span>
          <strong>{formatMoney(document.amountDue, document.currency)}</strong>
        </article>
      </section>
      {document.status !== "DRAFT" && <EmailPanel invoice={document} />}
      {document.status !== "DRAFT" && (
        <CommercialTimeline
          endpoint={`/api/invoices/${document.id}/commercial-events`}
          canManage
        />
      )}
      {document.status !== "DRAFT" && <PaymentsPanel invoice={document} />}
      <section className="invoice-detail-panel">
        <header>
          <div>
            <h2>Conceptos</h2>
            <p>{document.lines?.length ?? 0} líneas confirmadas por el API</p>
          </div>
        </header>
        <div className="table-scroll">
          <table className="data-table invoice-lines-table">
            <thead>
              <tr>
                <th>Descripción</th>
                <th>Cantidad</th>
                <th>Precio</th>
                <th>IVA</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {document.lines?.map((line) => (
                <tr key={line.id}>
                  <td>
                    <strong>{line.description}</strong>
                  </td>
                  <td>{formatQuantity(line.quantity)}</td>
                  <td className="money-cell">
                    {formatMoney(line.unitPrice, document.currency)}
                  </td>
                  <td>{Number(line.taxRate)} %</td>
                  <td className="money-cell">
                    {formatMoney(line.totalAmount, document.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="invoice-totals">
          <span>
            Base antes de descuentos{" "}
            <strong>{formatMoney(document.subtotal, document.currency)}</strong>
          </span>
          <span>
            Descuentos{" "}
            <strong>
              − {formatMoney(document.discountTotal, document.currency)}
            </strong>
          </span>
          <span>
            IVA{" "}
            <strong>{formatMoney(document.taxTotal, document.currency)}</strong>
          </span>
          <span className="grand-total">
            Total{" "}
            <strong>{formatMoney(document.total, document.currency)}</strong>
          </span>
        </div>
        {document.notes && (
          <p className="invoice-notes">
            <strong>Notas:</strong> {document.notes}
          </p>
        )}
      </section>
      {document.status !== "DRAFT" && <TracePanel invoice={document} />}
      {editing && (
        <InvoiceDialog
          initial={document}
          pending={updateInvoice.isPending}
          error={updateInvoice.error?.message}
          onClose={() => {
            setEditing(false);
            updateInvoice.reset();
          }}
          onSubmit={(payload) => updateInvoice.mutate(payload)}
        />
      )}
      {issuing && (
        <IssueDialog
          invoice={document}
          onClose={() => setIssuing(false)}
          onIssued={async (issued) => {
            queryClient.setQueryData(["invoice", id], issued);
            await queryClient.invalidateQueries({ queryKey: ["invoices"] });
            setIssuing(false);
            setNotice(`${issued.fullNumber} se ha emitido correctamente.`);
          }}
        />
      )}
      {rectifying && (
        <RectificationDialog
          invoice={document}
          pending={createRectification.isPending}
          error={createRectification.error?.message}
          onClose={() => {
            setRectifying(false);
            createRectification.reset();
          }}
          onSubmit={(payload) => createRectification.mutate(payload)}
        />
      )}
    </AppShell>
  );
}

function RectificationDialog({
  invoice,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  invoice: Invoice;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: RectificationInput): void;
}) {
  const originalIssueDate = invoice.issueDate.slice(0, 10);
  const defaultIssueDate =
    todayIso() < originalIssueDate ? originalIssueDate : todayIso();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      sifInvoiceType: String(
        values.get("sifInvoiceType"),
      ) as RectificationInput["sifInvoiceType"],
      reason: String(values.get("reason") ?? "").trim(),
      issueDate: String(values.get("issueDate")),
      dueDate: String(values.get("dueDate") ?? ""),
      notes: String(values.get("notes") ?? "").trim() || undefined,
    });
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="dialog payment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rectification-title"
      >
        <header>
          <div>
            <p className="eyebrow">Factura {invoice.fullNumber}</p>
            <h2 id="rectification-title">Rectificar factura completa</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        <form className="invoice-form" onSubmit={submit}>
          <p className="dialog-helper">
            Se creará un abono total en borrador, enlazado a la factura
            original. Podrás revisarlo antes de emitirlo.
          </p>
          <div className="payment-fields">
            <label className="field full">
              <span>Motivo fiscal AEAT</span>
              <select name="sifInvoiceType" defaultValue="R4" required>
                {(["R1", "R2", "R3", "R4"] as const).map((type) => (
                  <option key={type} value={type} disabled={type === "R1" && !invoice.operationDate}>
                    {type} · {sifInvoiceTypeLabel(type)}
                  </option>
                ))}
              </select>
              {!invoice.operationDate && (
                <small>R1 requiere una fecha de operación conservada en la factura original.</small>
              )}
            </label>
            <label className="field">
              <span>Fecha de rectificación</span>
              <input
                name="issueDate"
                type="date"
                min={originalIssueDate}
                defaultValue={defaultIssueDate}
                required
              />
            </label>
            <label className="field">
              <span>Nuevo vencimiento (opcional)</span>
              <input name="dueDate" type="date" />
            </label>
            <label className="field full">
              <span>Explicación de la rectificación</span>
              <textarea
                name="reason"
                minLength={5}
                maxLength={1000}
                rows={3}
                required
              />
            </label>
            <label className="field full">
              <span>Notas internas (opcional)</span>
              <textarea name="notes" maxLength={5000} rows={2} />
            </label>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={pending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="primary-button compact"
              disabled={pending}
            >
              {pending ? "Creando…" : "Crear rectificativa"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function EmailPanel({ invoice }: { invoice: Invoice }) {
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [notice, setNotice] = useState("");
  const capability = useQuery({
    queryKey: ["invoice-email-capability"],
    queryFn: () =>
      requestJson<InvoiceEmailCapability>("/api/invoices/email-capability"),
    staleTime: 60_000,
  });
  const deliveries = useQuery({
    queryKey: ["invoice-email-deliveries", invoice.id],
    queryFn: () =>
      requestJson<InvoiceEmailDelivery[]>(
        `/api/invoices/${invoice.id}/email-deliveries`,
      ),
    refetchInterval: (query) =>
      query.state.data?.some(({ status }) =>
        ["PENDING", "PROCESSING"].includes(status),
      )
        ? 5_000
        : false,
  });
  const send = useMutation({
    mutationFn: async (payload: InvoiceEmailInput) => {
      const storageName = deliveryRetryStorageKey(
        "invoice",
        invoice.id,
        payload.recipient,
        payload.subject,
      );
      const key = invoiceEmailKey(
        invoice.id,
        reusableDeliveryKey(
          sessionStorage.getItem(storageName),
          deliveries.data ?? [],
        ),
      );
      sessionStorage.setItem(storageName, key);
      const delivery = await requestJson<InvoiceEmailDelivery>(
        `/api/invoices/${invoice.id}/email`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, idempotencyKey: key }),
        },
      );
      return delivery;
    },
    onSuccess: async (delivery) => {
      await queryClient.invalidateQueries({
        queryKey: ["invoice-email-deliveries", invoice.id],
      });
      setComposing(false);
      setNotice(`Correo preparado para ${delivery.recipient}.`);
    },
  });
  return (
    <section className="email-panel" aria-labelledby="email-title">
      <header>
        <div>
          <p className="eyebrow">Entrega</p>
          <h2 id="email-title">Envío por correo</h2>
          <p>El PDF se genera al enviar y cada intento queda registrado.</p>
        </div>
        <div className="email-panel-actions">
          <button
            className="secondary-button compact"
            onClick={() => setReminding(true)}
            disabled={
              !capability.data?.enabled || Number(invoice.amountDue) <= 0
            }
            title={
              capability.data?.enabled
                ? undefined
                : "El envío por correo no está configurado"
            }
          >
            Recordatorio de pago
          </button>
          <button
            className="primary-button compact"
            onClick={() => setComposing(true)}
            disabled={!capability.data?.enabled}
            title={
              capability.data?.enabled
                ? undefined
                : "El envío por correo no está configurado"
            }
          >
            Enviar por email
          </button>
        </div>
      </header>
      {capability.data && !capability.data.enabled && (
        <div className="email-unavailable" role="note">
          <strong>Correo no configurado</strong>
          <span>
            Descarga el PDF para compartirlo manualmente. El envío directo se
            activará cuando haya un proveedor disponible.
          </span>
        </div>
      )}
      {notice && (
        <div className="notice payment-notice" role="status">
          <span>✓</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      {deliveries.error && (
        <div className="inline-error" role="alert">
          <strong>No se pudo cargar el historial de envíos</strong>
          <p>{deliveries.error.message}</p>
        </div>
      )}
      {deliveries.isPending && (
        <p className="dialog-helper">Cargando envíos…</p>
      )}
      {deliveries.data?.length === 0 && (
        <div className="payments-empty">
          <strong>La factura aún no se ha enviado</strong>
          <p>Cuando la envíes podrás seguir aquí su estado.</p>
        </div>
      )}
      {!!deliveries.data?.length && (
        <div className="table-scroll">
          <table className="data-table email-table">
            <thead>
              <tr>
                <th>Destinatario</th>
                <th>Asunto</th>
                <th>Estado</th>
                <th>Intentos</th>
                <th>Actualizado</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.data.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.recipient}</td>
                  <td>
                    {delivery.subject}
                    {delivery.purpose === "PAYMENT_REMINDER" && (
                      <small>Recordatorio de pago</small>
                    )}
                  </td>
                  <td>
                    <span
                      className={`delivery-status ${delivery.status.toLowerCase()}`}
                    >
                      {deliveryStatusLabel(delivery.status)}
                    </span>
                    {delivery.lastError && <small>{delivery.lastError}</small>}
                  </td>
                  <td>{delivery.attempts}</td>
                  <td>
                    {formatInvoiceDate(delivery.sentAt ?? delivery.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {composing && (
        <EmailDialog
          invoice={invoice}
          pending={send.isPending}
          error={send.error?.message}
          onClose={() => {
            setComposing(false);
            send.reset();
          }}
          onSubmit={(payload) => send.mutate(payload)}
        />
      )}
      {reminding && (
        <PaymentReminderDialog
          targets={[
            { id: invoice.id, number: invoice.fullNumber ?? invoice.draftCode },
          ]}
          mode="single"
          onClose={() => setReminding(false)}
          onQueued={async () => {
            await queryClient.invalidateQueries({
              queryKey: ["invoice-email-deliveries", invoice.id],
            });
            setReminding(false);
            setNotice("Recordatorio de pago preparado para su envío.");
          }}
        />
      )}
    </section>
  );
}

function EmailDialog({
  invoice,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  invoice: Invoice;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: InvoiceEmailInput): void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      recipient: String(values.get("recipient") ?? "").trim(),
      subject: String(values.get("subject") ?? "").trim(),
    });
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog email-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-dialog-title"
      >
        <header>
          <div>
            <p className="eyebrow">Factura {invoice.fullNumber}</p>
            <h2 id="email-dialog-title">Enviar por email</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        <form className="invoice-form" onSubmit={submit}>
          <label className="field">
            <span>Destinatario</span>
            <input
              name="recipient"
              type="email"
              required
              maxLength={320}
              defaultValue={invoice.customerEmail ?? ""}
              autoComplete="email"
            />
          </label>
          <label className="field">
            <span>Asunto</span>
            <input
              name="subject"
              required
              maxLength={300}
              defaultValue={`Factura ${invoice.fullNumber}`}
            />
          </label>
          <p className="dialog-helper">
            Se adjuntará el PDF oficial. Podrás comprobar el estado en el
            historial de esta factura.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={pending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="primary-button compact"
              disabled={pending}
            >
              {pending ? "Preparando…" : "Confirmar envío"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function deliveryStatusLabel(status: InvoiceEmailDelivery["status"]) {
  return {
    PENDING: "Pendiente",
    PROCESSING: "Enviando",
    SENT: "Enviado",
    FAILED: "Fallido",
  }[status];
}

function TracePanel({ invoice }: { invoice: Invoice }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const cancelIssuedInvoice = useMutation({
    mutationFn: (reason: string) =>
      requestJson<Invoice>(
        `/api/invoices/${invoice.id}/cancel-issued-in-error`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason, operationDidNotExist: true }),
        },
      ),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["invoice", invoice.id], updated);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["invoice-trace", invoice.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({
          queryKey: ["invoice-payment-schedule", invoice.id],
        }),
      ]);
      setNotice(
        "Factura anulada como emitida por error. Se han registrado las reversiones fiscal y contable.",
      );
    },
  });
  const trace = useQuery({
    queryKey: ["invoice-trace", invoice.id],
    queryFn: () =>
      requestJson<InvoiceTrace>(`/api/invoices/${invoice.id}/trace`),
  });
  const cancelSifRecord = useMutation({
    mutationFn: () =>
      requestJson(`/api/sif/records/${invoice.id}/cancellation`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["invoice-trace", invoice.id],
      });
      setNotice("Se ha añadido el registro SIF de anulación.");
    },
  });
  const subsanateTimestamp = useMutation({
    mutationFn: () =>
      requestJson(`/api/sif/records/${invoice.id}/timestamp-subsanation`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["invoice-trace", invoice.id],
      });
      setNotice("Se ha añadido un alta de subsanación a la cadena SIF.");
    },
  });
  const registrationSubmission = trace.data?.aeatTestSubmissions.find(
    (entry) => entry.recordId === trace.data?.sifRecord?.id,
  )?.submissions[0];
  const definitiveAeatResponse =
    registrationSubmission?.status === "ACCEPTED" ||
    registrationSubmission?.status === "ACCEPTED_WITH_ERRORS" ||
    (registrationSubmission?.status === "REJECTED" &&
      registrationSubmission.recordStatus === "Incorrecto");
  const timestampWarning =
    registrationSubmission?.status === "ACCEPTED_WITH_ERRORS" &&
    registrationSubmission.recordStatus === "AceptadoConErrores" &&
    registrationSubmission.errorDescription?.includes(
      "FechaHoraHusoGenRegistro",
    );
  return (
    <section
      className="trace-panel"
      id="trazabilidad"
      aria-labelledby="trace-title"
    >
      <header>
        <p className="eyebrow">Trazabilidad</p>
        <h2 id="trace-title">Impacto fiscal y contable</h2>
        <p>Registros generados automáticamente al emitir.</p>
      </header>
      {invoice.status === "CANCELLED" && invoice.cancelledAt && (
        <p role="status">
          Factura anulada el {formatInvoiceDate(invoice.cancelledAt)} por
          operación inexistente.
          {invoice.cancellationReason
            ? ` Motivo: ${invoice.cancellationReason}`
            : ""}
        </p>
      )}
      {invoice.documentType === "INVOICE" &&
        ["ISSUED", "SENT", "OVERDUE"].includes(invoice.status) &&
        Number(invoice.amountPaid) === 0 && (
          <div className="trace-actions">
            <button
              className="secondary-button compact"
              disabled={cancelIssuedInvoice.isPending}
              onClick={() => {
                const reason = window
                  .prompt(
                    "Solo para una factura emitida por error cuando no existió la operación. Indica el motivo (mínimo 20 caracteres). Para una operación real, usa una rectificativa:",
                  )
                  ?.trim();
                if (!reason) return;
                if (reason.length < 20) {
                  setNotice("El motivo debe tener al menos 20 caracteres.");
                  return;
                }
                if (
                  window.confirm(
                    "Confirmo que la operación no existió. Se conservará la factura original y se crearán la anulación SIF y las reversiones de IVA y contabilidad. ¿Continuar?",
                  )
                )
                  cancelIssuedInvoice.mutate(reason);
              }}
              type="button"
            >
              {cancelIssuedInvoice.isPending
                ? "Anulando factura…"
                : "Anular factura emitida por error"}
            </button>
          </div>
        )}
      {cancelIssuedInvoice.error && (
        <p className="form-error">{cancelIssuedInvoice.error.message}</p>
      )}
      {notice && <small role="status">{notice}</small>}
      {trace.isPending && (
        <p className="dialog-helper">Cargando trazabilidad…</p>
      )}
      {trace.error && <p className="form-error">{trace.error.message}</p>}
      {trace.data && (
        <div className="trace-grid">
          <article>
            <span>Asiento contable</span>
            {trace.data.journalEntry ? (
              <>
                <strong>Asiento #{trace.data.journalEntry.entryNumber}</strong>
                <small>{trace.data.journalEntry.description}</small>
                <dl>
                  <div>
                    <dt>Debe</dt>
                    <dd>
                      {formatMoney(
                        sumJournal(trace.data.journalEntry.lines, "debit"),
                        invoice.currency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Haber</dt>
                    <dd>
                      {formatMoney(
                        sumJournal(trace.data.journalEntry.lines, "credit"),
                        invoice.currency,
                      )}
                    </dd>
                  </div>
                </dl>
                {trace.data.journalReversalEntry && (
                  <small>
                    Reversión · asiento #
                    {trace.data.journalReversalEntry.entryNumber} ·{" "}
                    {formatInvoiceDate(
                      trace.data.journalReversalEntry.entryDate,
                    )}
                  </small>
                )}
              </>
            ) : (
              <strong>No encontrado</strong>
            )}
          </article>
          <article>
            <span>Libro de IVA</span>
            {trace.data.taxEntry ? (
              <>
                <strong>{trace.data.taxEntry.documentNumber}</strong>
                <small>
                  Ventas · {formatInvoiceDate(trace.data.taxEntry.taxPointDate)}
                </small>
                <dl>
                  <div>
                    <dt>Base</dt>
                    <dd>
                      {formatMoney(
                        sumTax(trace.data.taxEntry.amounts, "taxableBase"),
                        invoice.currency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Cuota</dt>
                    <dd>
                      {formatMoney(
                        sumTax(trace.data.taxEntry.amounts, "taxAmount"),
                        invoice.currency,
                      )}
                    </dd>
                  </div>
                </dl>
                {trace.data.taxCancellationEntry && (
                  <small>
                    Apunte de anulación · base{" "}
                    {formatMoney(
                      sumTax(
                        trace.data.taxCancellationEntry.amounts,
                        "taxableBase",
                      ),
                      invoice.currency,
                    )}{" "}
                    · cuota{" "}
                    {formatMoney(
                      sumTax(
                        trace.data.taxCancellationEntry.amounts,
                        "taxAmount",
                      ),
                      invoice.currency,
                    )}
                  </small>
                )}
              </>
            ) : (
              <strong>No encontrado</strong>
            )}
          </article>
          <article>
            <span>Registro SIF</span>
            {trace.data.sifRecord ? (
              <>
                <strong>
                  Alta · posición {trace.data.sifRecord.chainPosition}
                </strong>
                <small>
                  {trace.data.sifRecord.hashAlgorithm} · tipo{" "}
                  {trace.data.sifRecord.invoiceType}
                </small>
                <small>
                  {trace.data.sifVerification.valid
                    ? `Cadena SIF verificada · ${trace.data.sifVerification.recordsChecked} registros`
                    : `Cadena SIF con incidencia · ${trace.data.sifVerification.firstInvalid?.reason ?? "revisar registro"}`}
                </small>
                {invoice.sifMode === "VERIFACTU" &&
                  trace.data.sifRecords.map((record) => {
                    const submission = trace.data.aeatTestSubmissions.find(
                      (entry) => entry.recordId === record.id,
                    )?.submissions[0];
                    return (
                      <small key={`aeat-${record.id}`} role="status">
                        AEAT pruebas ·{" "}
                        {record.recordType === "REGISTRATION"
                          ? "alta"
                          : record.recordType === "SUBSANATION"
                            ? "subsanación"
                            : "anulación"}
                        :{" "}
                        {submission
                          ? aeatTestStatusLabel(submission.status)
                          : "sin envío"}
                        {submission?.csv ? ` · CSV ${submission.csv}` : ""}
                        {submission?.errorDescription
                          ? ` · ${submission.errorDescription}`
                          : ""}
                        {submission?.lastError
                          ? ` · ${submission.lastError}`
                          : ""}
                      </small>
                    );
                  })}
                {trace.data.sifRecords.some(
                  (record) => record.recordType === "CANCELLATION",
                ) && (
                  <small>
                    Anulación SIF · posición{" "}
                    {
                      trace.data.sifRecords.find(
                        (record) => record.recordType === "CANCELLATION",
                      )?.chainPosition
                    }
                  </small>
                )}
                <dl>
                  <div>
                    <dt>Huella</dt>
                    <dd title={trace.data.sifRecord.recordHash}>
                      {shortHash(trace.data.sifRecord.recordHash)}
                    </dd>
                  </div>
                  <div>
                    <dt>Especificación</dt>
                    <dd>{trace.data.sifRecord.specificationVersion}</dd>
                  </div>
                </dl>
                <div className="trace-actions">
                  {trace.data.sifRecords.map((record) => (
                    <a
                      className="secondary-button compact"
                      href={`/api/sif/records/${record.id}/xml`}
                      key={record.id}
                    >
                      Descargar XML{" "}
                      {record.recordType === "REGISTRATION"
                        ? "de alta"
                        : record.recordType === "SUBSANATION"
                          ? "de subsanación"
                          : "de anulación"}
                    </a>
                  ))}
                  {invoice.sifMode === "VERIFACTU" &&
                    timestampWarning &&
                    !trace.data.sifRecords.some(
                      (record) =>
                        record.recordType === "SUBSANATION" ||
                        record.recordType === "CANCELLATION",
                    ) && (
                      <button
                        className="secondary-button compact"
                        disabled={subsanateTimestamp.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Se enviará a AEAT pruebas una nueva alta de subsanación con la hora actual. El alta anterior y la factura permanecerán intactas. ¿Continuar?",
                            )
                          )
                            subsanateTimestamp.mutate();
                        }}
                        type="button"
                      >
                        {subsanateTimestamp.isPending
                          ? "Subsanando…"
                          : "Subsanar aviso de fecha/hora"}
                      </button>
                    )}
                  {invoice.documentType === "CREDIT_NOTE" &&
                    !trace.data.sifRecords.some(
                      (record) => record.recordType === "CANCELLATION",
                    ) &&
                    (invoice.sifMode !== "VERIFACTU" ||
                      definitiveAeatResponse) && (
                      <button
                        className="secondary-button compact"
                        disabled={cancelSifRecord.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Esto añade un registro SIF de anulación. No cancela la factura, el asiento contable ni el IVA. ¿Continuar?",
                            )
                          )
                            cancelSifRecord.mutate();
                        }}
                        type="button"
                      >
                        {cancelSifRecord.isPending
                          ? "Anulando registro…"
                          : "Anular registro SIF"}
                      </button>
                    )}
                </div>
                {cancelSifRecord.error && (
                  <p className="form-error">{cancelSifRecord.error.message}</p>
                )}
                {subsanateTimestamp.error && (
                  <p className="form-error">
                    {subsanateTimestamp.error.message}
                  </p>
                )}
                {invoice.documentType === "CREDIT_NOTE" &&
                  !trace.data.sifRecords.some(
                    (record) => record.recordType === "CANCELLATION",
                  ) && (
                    <small>
                      La corrección económica exige emitir una factura
                      rectificativa.
                    </small>
                  )}
              </>
            ) : (
              <strong>
                {invoice.sifMode === "DISABLED"
                  ? "No aplica (SIF desactivado)"
                  : "No encontrado"}
              </strong>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

function shortHash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function aeatTestStatusLabel(status: string) {
  switch (status) {
    case "PENDING":
      return "pendiente";
    case "SENDING":
      return "enviando";
    case "RETRY":
      return "reintento programado";
    case "ACCEPTED":
      return "aceptado";
    case "ACCEPTED_WITH_ERRORS":
      return "aceptado con errores";
    case "REJECTED":
      return "rechazado";
    case "FAILED":
      return "fallo sin envío confirmado";
    case "UNKNOWN":
      return "resultado incierto: verificar en AEAT";
    default:
      return status;
  }
}

function PaymentsPanel({ invoice }: { invoice: Invoice }) {
  const queryClient = useQueryClient();
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const payments = useQuery({
    queryKey: ["invoice-payments", invoice.id],
    queryFn: () =>
      requestJson<Payment[]>(`/api/invoices/${invoice.id}/payments`),
  });
  const schedule = useQuery({
    queryKey: ["invoice-payment-schedule", invoice.id],
    queryFn: () =>
      requestJson<PaymentInstallment[]>(
        `/api/invoices/${invoice.id}/payment-schedule`,
      ),
  });
  const record = useMutation({
    mutationFn: async (payload: PaymentInput) => {
      const storageName = `pastagansa:payment:${invoice.id}`;
      const key = paymentKey(invoice.id, sessionStorage.getItem(storageName));
      sessionStorage.setItem(storageName, key);
      const payment = await requestJson<Payment>(
        `/api/invoices/${invoice.id}/payments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, idempotencyKey: key }),
        },
      );
      sessionStorage.removeItem(storageName);
      return payment;
    },
    onSuccess: async (payment) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["invoice", invoice.id] }),
        queryClient.invalidateQueries({
          queryKey: ["invoice-payments", invoice.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["invoice-payment-schedule", invoice.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
      ]);
      setRecording(false);
      setNotice(
        `Cobro de ${formatMoney(payment.amount, payment.currency)} registrado.`,
      );
    },
  });
  const eligible = ["ISSUED", "SENT", "PARTIALLY_PAID", "OVERDUE"].includes(
    invoice.status,
  );

  return (
    <section className="payments-panel" aria-labelledby="payments-title">
      <header>
        <div>
          <p className="eyebrow">Tesorería</p>
          <h2 id="payments-title">Cobros</h2>
          <p>
            {invoice.status === "CANCELLED"
              ? "Factura anulada: no hay saldo exigible."
              : schedule.data?.length
              ? nextInstallmentText(schedule.data, invoice.currency)
              : "Consultando vencimientos…"}
          </p>
        </div>
        {eligible && Number(invoice.amountDue) > 0 && (
          <button
            className="primary-button compact"
            onClick={() => setRecording(true)}
          >
            Registrar cobro
          </button>
        )}
      </header>
      {notice && (
        <div className="notice payment-notice" role="status">
          <span>✓</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      {(payments.error || schedule.error) && (
        <div className="inline-error" role="alert">
          <strong>No se pudo cargar la información de cobros</strong>
          <p>{payments.error?.message ?? schedule.error?.message}</p>
        </div>
      )}
      {payments.isPending && <p className="dialog-helper">Cargando cobros…</p>}
      {payments.data?.length === 0 && (
        <div className="payments-empty">
          <strong>Sin cobros registrados</strong>
          <p>
            El saldo pendiente es{" "}
            {formatMoney(invoice.amountDue, invoice.currency)}.
          </p>
        </div>
      )}
      {!!payments.data?.length && (
        <div className="table-scroll">
          <table className="data-table payments-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Método</th>
                <th>Referencia</th>
                <th>Importe</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((payment) => (
                <tr key={payment.id}>
                  <td>{formatInvoiceDate(payment.paidAt)}</td>
                  <td>{paymentMethodLabel(payment.method)}</td>
                  <td>{payment.reference ?? "—"}</td>
                  <td className="money-cell">
                    {formatMoney(payment.amount, payment.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {recording && (
        <PaymentDialog
          invoice={invoice}
          pending={record.isPending}
          error={record.error?.message}
          onClose={() => {
            setRecording(false);
            record.reset();
          }}
          onSubmit={(payload) => record.mutate(payload)}
        />
      )}
    </section>
  );
}

function PaymentDialog({
  invoice,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  invoice: Invoice;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: PaymentInput): void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      amount: Number(values.get("amount")),
      paidAt: String(values.get("paidAt")),
      method: String(values.get("method")) as PaymentInput["method"],
      reference: String(values.get("reference") ?? "").trim() || undefined,
      notes: String(values.get("notes") ?? "").trim() || undefined,
    });
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="dialog payment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-title"
      >
        <header>
          <div>
            <p className="eyebrow">Nuevo movimiento</p>
            <h2 id="payment-title">Registrar cobro</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        <form className="invoice-form" onSubmit={submit}>
          <div className="payment-balance">
            <span>Saldo pendiente</span>
            <strong>{formatMoney(invoice.amountDue, invoice.currency)}</strong>
          </div>
          <div className="payment-fields">
            <label className="field">
              <span>Importe</span>
              <input
                name="amount"
                type="number"
                required
                min="0.01"
                max={invoice.amountDue}
                step="0.01"
                defaultValue={Number(invoice.amountDue).toFixed(2)}
              />
            </label>
            <label className="field">
              <span>Fecha del cobro</span>
              <input
                name="paidAt"
                type="date"
                required
                defaultValue={todayIso()}
              />
            </label>
            <label className="field full">
              <span>Método</span>
              <select name="method" defaultValue="BANK_TRANSFER">
                <option value="BANK_TRANSFER">Transferencia</option>
                <option value="DIRECT_DEBIT">Domiciliación</option>
                <option value="CASH">Efectivo</option>
                <option value="CARD">Tarjeta</option>
                <option value="OTHER">Otro</option>
              </select>
            </label>
            <label className="field full">
              <span>Referencia (opcional)</span>
              <input
                name="reference"
                maxLength={240}
                placeholder="Movimiento bancario, recibo…"
              />
            </label>
            <label className="field full">
              <span>Notas (opcional)</span>
              <textarea name="notes" rows={2} maxLength={1000} />
            </label>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={pending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="primary-button compact"
              disabled={pending}
            >
              {pending ? "Registrando…" : "Confirmar cobro"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function IssueDialog({
  invoice,
  onClose,
  onIssued,
}: {
  invoice: Invoice;
  onClose(): void;
  onIssued(invoice: Invoice): Promise<void>;
}) {
  const sequences = useQuery({
    queryKey: ["document-sequences"],
    queryFn: () => requestJson<DocumentSequence[]>("/api/document-sequences"),
  });
  const issue = useMutation({
    mutationFn: async ({
      sequenceId,
      series,
    }: {
      sequenceId: string;
      series: string;
    }) => {
      let selectedId = sequenceId;
      if (!selectedId) {
        const created = await requestJson<DocumentSequence>(
          "/api/document-sequences",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              documentType: invoice.documentType,
              series,
            }),
          },
        );
        selectedId = created.id;
      }
      const storageName = `pastagansa:issue:${invoice.id}`;
      const key = invoiceIssueKey(
        invoice.id,
        sessionStorage.getItem(storageName),
      );
      sessionStorage.setItem(storageName, key);
      const issued = await requestJson<Invoice>(
        `/api/invoices/${invoice.id}/issue`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sequenceId: selectedId, idempotencyKey: key }),
        },
      );
      sessionStorage.removeItem(storageName);
      return issued;
    },
    onSuccess: onIssued,
  });
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const active = sequences.data?.filter(
    (sequence) =>
      sequence.active && sequence.documentType === invoice.documentType,
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    issue.mutate({
      sequenceId: String(values.get("sequenceId") ?? ""),
      series: String(values.get("series") ?? "").trim(),
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog issue-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="issue-title"
      >
        <header>
          <div>
            <p className="eyebrow">Acción irreversible</p>
            <h2 id="issue-title">
              Emitir{" "}
              {invoice.documentType === "CREDIT_NOTE"
                ? "rectificativa"
                : "factura"}
            </h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={issue.isPending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        <p className="issue-warning">
          Al emitir se asignará un número definitivo. El documento dejará de ser
          editable y se generarán sus registros fiscal y contable.
        </p>
        {sequences.isPending && (
          <p className="dialog-helper">Cargando series…</p>
        )}
        {sequences.error && (
          <p className="form-error">{sequences.error.message}</p>
        )}
        {active && (
          <form className="invoice-form" onSubmit={submit}>
            {active.length ? (
              <label className="field">
                <span>Serie de facturación</span>
                <select name="sequenceId" defaultValue={active[0].id} required>
                  {active.map((sequence) => (
                    <option key={sequence.id} value={sequence.id}>
                      {sequence.series} · próximo{" "}
                      {sequence.nextNumber.padStart(sequence.padding, "0")}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span>Nueva serie</span>
                <input
                  name="series"
                  required
                  maxLength={30}
                  pattern="[A-Za-z0-9][A-Za-z0-9._/-]*"
                  defaultValue={`${invoice.documentType === "CREDIT_NOTE" ? "R" : "F"}${invoice.issueDate.slice(0, 4)}`}
                />
                <small>
                  Se creará para esta empresa comenzando por el número 1.
                </small>
              </label>
            )}
            <div className="issue-amount">
              <span>Total definitivo</span>
              <strong>{formatMoney(invoice.total, invoice.currency)}</strong>
            </div>
            {issue.error && (
              <p className="form-error" role="alert">
                {issue.error.message}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onClose}
                disabled={issue.isPending}
              >
                Seguir editando
              </button>
              <button
                type="submit"
                className="primary-button compact"
                disabled={issue.isPending}
              >
                {issue.isPending ? "Emitiendo…" : "Emitir definitivamente"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "No se pudo completar la operación.");
  return body;
}

function formatQuantity(value: string) {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 3 }).format(
    Number(value),
  );
}

function nextInstallmentText(
  installments: PaymentInstallment[],
  currency: string,
) {
  const open = installments.find(
    (installment) => installment.status !== "PAID",
  );
  if (!open) return "Todos los vencimientos están cobrados.";
  const pending = Number(open.amount) - Number(open.paidAmount);
  return `Próximo vencimiento: ${formatInvoiceDate(open.dueDate)} · ${formatMoney(String(pending), currency)}`;
}

function sumJournal(
  lines: Array<{ debit: string; credit: string }>,
  field: "debit" | "credit",
) {
  return String(lines.reduce((sum, line) => sum + Number(line[field]), 0));
}

function sumTax(
  amounts: Array<{ taxableBase: string; taxAmount: string }>,
  field: "taxableBase" | "taxAmount",
) {
  return String(
    amounts.reduce((sum, amount) => sum + Number(amount[field]), 0),
  );
}

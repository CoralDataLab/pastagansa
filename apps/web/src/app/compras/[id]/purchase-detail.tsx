"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { formatMoney } from "@/lib/catalog";
import {
  formatInvoiceDate,
  paymentMethodLabel,
  todayIso,
  type DocumentSequence,
  type PaymentInput,
} from "@/lib/invoices";
import {
  approvalKey,
  purchaseStatusLabel,
  supplierPaymentKey,
  type Purchase,
  type PurchaseAttachment,
  type PurchaseInput,
  type PurchaseOcrJob,
  type PurchaseTrace,
  type SupplierPayment,
} from "@/lib/purchases";
import { PurchaseDialog } from "../purchases-view";

export function PurchaseDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [notice, setNotice] = useState("");
  const purchase = useQuery({
    queryKey: ["purchase", id],
    queryFn: () => requestJson<Purchase>(`/api/purchases/${id}`),
    retry: false,
  });
  const ocrJobs = useQuery({
    queryKey: ["purchase-ocr", id],
    queryFn: () => requestJson<PurchaseOcrJob[]>(`/api/purchases/${id}/ocr`),
    refetchInterval: ocrPollInterval,
  });
  const update = useMutation({
    mutationFn: (payload: PurchaseInput) =>
      requestJson<Purchase>(`/api/purchases/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["purchase", id], updated);
      await queryClient.invalidateQueries({ queryKey: ["purchases"] });
      setEditing(false);
      setNotice("Los cambios del borrador se han guardado.");
    },
  });

  if (purchase.isPending)
    return (
      <AppShell active="compras">
        <section className="detail-loading">
          <div className="spinner" />
          <p>Cargando compra…</p>
        </section>
      </AppShell>
    );
  if (purchase.error)
    return (
      <AppShell active="compras">
        <section className="detail-error">
          <p className="eyebrow">No se pudo abrir</p>
          <h1>Compra no disponible</h1>
          <p>{purchase.error.message}</p>
          <Link className="primary-link" href="/compras">
            Volver a compras
          </Link>
        </section>
      </AppShell>
    );

  const document = purchase.data;
  const pendingReview = ocrJobs.data?.some((job) => job.status !== "REVIEWED");
  return (
    <AppShell active="compras">
      <section className="detail-heading">
        <div>
          <Link className="back-link" href="/compras">
            ← Compras
          </Link>
          <p className="eyebrow">
            Factura recibida · {document.supplierInvoiceNumber}
          </p>
          <h1>{document.receptionFullNumber ?? "Compra en borrador"}</h1>
          <p>{document.supplierLegalName}</p>
        </div>
        <div className="detail-actions">
          {document.status === "DRAFT" && (
            <>
              <button
                className="secondary-button"
                onClick={() => setEditing(true)}
              >
                Editar borrador
              </button>
              <button
                className="primary-button compact"
                onClick={() => setApproving(true)}
                disabled={ocrJobs.isPending || pendingReview}
                title={
                  pendingReview
                    ? "Revisa todas las extracciones OCR antes de aprobar"
                    : undefined
                }
              >
                Aprobar compra
              </button>
            </>
          )}
          {document.status === "APPROVED" && (
            <a className="secondary-button trace-link" href="#trazabilidad">
              Ver trazabilidad
            </a>
          )}
        </div>
      </section>
      {notice && (
        <div className="notice" role="status">
          <span>✓</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      {document.status === "DRAFT" && pendingReview && (
        <div className="inline-warning" role="status">
          Revisa todas las extracciones OCR antes de aprobar la compra.
        </div>
      )}
      <section className="invoice-summary-grid">
        <article className="summary-card">
          <span>Estado</span>
          <strong>{purchaseStatusLabel(document.status)}</strong>
        </article>
        <article className="summary-card">
          <span>Factura proveedor</span>
          <strong>{document.supplierInvoiceNumber}</strong>
        </article>
        <article className="summary-card">
          <span>Recepción</span>
          <strong>{formatInvoiceDate(document.receivedDate)}</strong>
        </article>
        <article className="summary-card total-card">
          <span>Total</span>
          <strong>{formatMoney(document.total, document.currency)}</strong>
        </article>
        <article className="summary-card">
          <span>Pagado</span>
          <strong>{formatMoney(document.amountPaid, document.currency)}</strong>
        </article>
        <article className="summary-card due-card">
          <span>Pendiente</span>
          <strong>{formatMoney(document.amountDue, document.currency)}</strong>
        </article>
      </section>
      {document.status === "APPROVED" && <PaymentsPanel purchase={document} />}
      <section className="invoice-detail-panel">
        <header>
          <h2>Conceptos</h2>
          <p>{document.lines?.length ?? 0} líneas confirmadas por el API</p>
        </header>
        <div className="table-scroll">
          <table className="data-table invoice-lines-table">
            <thead>
              <tr>
                <th>Descripción</th>
                <th>Cantidad</th>
                <th>Precio</th>
                <th>IVA</th>
                <th>Deducible</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {document.lines?.map((line) => (
                <tr key={line.id}>
                  <td>
                    <strong>{line.description}</strong>
                  </td>
                  <td>{Number(line.quantity).toLocaleString("es-ES")}</td>
                  <td className="money-cell">
                    {formatMoney(line.unitPrice, document.currency)}
                  </td>
                  <td>{Number(line.taxLines[0]?.taxRate ?? 0)} %</td>
                  <td>{Number(line.taxLines[0]?.deductiblePct ?? 0)} %</td>
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
            Base{" "}
            <strong>
              {formatMoney(
                String(
                  Number(document.subtotal) - Number(document.discountTotal),
                ),
                document.currency,
              )}
            </strong>
          </span>
          <span>
            IVA soportado{" "}
            <strong>{formatMoney(document.taxTotal, document.currency)}</strong>
          </span>
          <span>
            IVA deducible{" "}
            <strong>
              {formatMoney(document.deductibleTaxTotal, document.currency)}
            </strong>
          </span>
          <span className="grand-total">
            Total{" "}
            <strong>{formatMoney(document.total, document.currency)}</strong>
          </span>
          {Number(document.withholdingAmount) > 0 && (
            <>
              <span>IRPF retenido <strong>{formatMoney(document.withholdingAmount, document.currency)}</strong></span>
              <span>Neto al proveedor <strong>{formatMoney(String(Number(document.total) - Number(document.withholdingAmount)), document.currency)}</strong></span>
            </>
          )}
        </div>
        {document.notes && (
          <p className="invoice-notes">
            <strong>Notas:</strong> {document.notes}
          </p>
        )}
      </section>
      <AttachmentsPanel purchase={document} />
      {document.status === "APPROVED" && <TracePanel purchase={document} />}
      {editing && (
        <PurchaseDialog
          initial={document}
          pending={update.isPending}
          error={update.error?.message}
          onClose={() => {
            setEditing(false);
            update.reset();
          }}
          onSubmit={(payload) => update.mutate(payload)}
        />
      )}
      {approving && (
        <ApprovalDialog
          purchase={document}
          onClose={() => setApproving(false)}
          onApproved={async (approved) => {
            queryClient.setQueryData(["purchase", id], approved);
            await queryClient.invalidateQueries({ queryKey: ["purchases"] });
            setApproving(false);
            setNotice(
              `${approved.receptionFullNumber ?? "La compra"} se ha aprobado correctamente.`,
            );
          }}
        />
      )}
    </AppShell>
  );
}

function AttachmentsPanel({ purchase }: { purchase: Purchase }) {
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<string>();
  const attachments = useQuery({
    queryKey: ["purchase-attachments", purchase.id],
    queryFn: () =>
      requestJson<PurchaseAttachment[]>(
        `/api/purchases/${purchase.id}/attachments`,
      ),
  });
  const jobs = useQuery({
    queryKey: ["purchase-ocr", purchase.id],
    queryFn: () =>
      requestJson<PurchaseOcrJob[]>(`/api/purchases/${purchase.id}/ocr`),
    refetchInterval: ocrPollInterval,
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.set("file", file);
      return requestJson<PurchaseAttachment>(
        `/api/purchases/${purchase.id}/attachments`,
        { method: "POST", body },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["purchase-attachments", purchase.id],
      });
    },
  });
  const queue = useMutation({
    mutationFn: (attachmentId: string) =>
      requestJson<PurchaseOcrJob>(
        `/api/purchases/${purchase.id}/ocr/attachments/${attachmentId}`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["purchase-ocr", purchase.id],
      });
    },
  });
  const jobsByAttachment = new Map(
    jobs.data?.map((job) => [job.attachmentId, job]),
  );
  return (
    <section className="attachments-panel" aria-labelledby="attachments-title">
      <header>
        <div>
          <p className="eyebrow">Evidencia</p>
          <h2 id="attachments-title">Adjuntos y OCR</h2>
          <p>
            PDF se conserva como evidencia; OCR local solo procesa PNG/JPEG.
          </p>
        </div>
        {purchase.status === "DRAFT" && (
          <label className="secondary-button upload-button">
            {upload.isPending ? "Subiendo…" : "Añadir archivo"}
            <input
              className="sr-only"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        )}
      </header>
      {(attachments.error || jobs.error || upload.error || queue.error) && (
        <p className="form-error">
          {attachments.error?.message ??
            jobs.error?.message ??
            upload.error?.message ??
            queue.error?.message}
        </p>
      )}
      {attachments.isPending && (
        <p className="dialog-helper">Cargando adjuntos…</p>
      )}
      {attachments.data?.length === 0 && (
        <div className="payments-empty">
          <strong>Sin documentos adjuntos</strong>
          <p>Añade la factura recibida en PDF, PNG o JPEG.</p>
        </div>
      )}
      {!!attachments.data?.length && (
        <div className="attachment-list">
          {attachments.data.map((attachment) => {
            const job = jobsByAttachment.get(attachment.id);
            const compatible = attachment.mediaType !== "application/pdf";
            return (
              <article key={attachment.id}>
                <div>
                  <a
                    href={`/api/purchases/${purchase.id}/attachments/${attachment.id}/download`}
                    download
                  >
                    {attachment.originalName}
                  </a>
                  <small>
                    {attachment.mediaType} ·{" "}
                    {formatFileSize(attachment.sizeBytes)}
                  </small>
                </div>
                <div className="attachment-actions">
                  {!compatible && <span>OCR no disponible para PDF</span>}
                  {compatible && !job && purchase.status === "DRAFT" && (
                    <button onClick={() => queue.mutate(attachment.id)}>
                      Solicitar OCR
                    </button>
                  )}
                  {job && (
                    <span className="tag tag-neutral">
                      {ocrStatusLabel(job.status)}
                    </span>
                  )}
                  {job?.status === "FAILED" && purchase.status === "DRAFT" && (
                    <button onClick={() => queue.mutate(attachment.id)}>
                      Reintentar OCR
                    </button>
                  )}
                  {job?.status === "REVIEW_REQUIRED" && (
                    <button onClick={() => setReviewing(job.id)}>
                      Revisar extracción
                    </button>
                  )}
                  {job?.status === "REVIEWED" && (
                    <strong>Revisión humana completada</strong>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {reviewing && (
        <OcrReviewDialog
          purchaseId={purchase.id}
          jobId={reviewing}
          onClose={() => setReviewing(undefined)}
          onReviewed={async () => {
            await queryClient.invalidateQueries({
              queryKey: ["purchase-ocr", purchase.id],
            });
            setReviewing(undefined);
          }}
        />
      )}
    </section>
  );
}

const reviewFields = [
  ["supplierName", "Proveedor"],
  ["taxId", "NIF"],
  ["invoiceNumber", "Número de factura"],
  ["issueDate", "Fecha de emisión"],
  ["taxableBase", "Base imponible"],
  ["taxAmount", "IVA"],
  ["total", "Total"],
  ["dueDate", "Vencimiento"],
  ["iban", "IBAN"],
] as const;

function OcrReviewDialog({
  purchaseId,
  jobId,
  onClose,
  onReviewed,
}: {
  purchaseId: string;
  jobId: string;
  onClose(): void;
  onReviewed(): Promise<void>;
}) {
  const job = useQuery({
    queryKey: ["purchase-ocr-job", jobId],
    queryFn: () =>
      requestJson<PurchaseOcrJob>(`/api/purchases/${purchaseId}/ocr/${jobId}`),
  });
  const review = useMutation({
    mutationFn: (input: {
      fields: Record<string, string | null>;
      notes: string;
    }) =>
      requestJson<PurchaseOcrJob>(
        `/api/purchases/${purchaseId}/ocr/${jobId}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: onReviewed,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const fields = Object.fromEntries(
      reviewFields.map(([key]) => [
        key,
        String(values.get(key) ?? "").trim() || null,
      ]),
    );
    review.mutate({ fields, notes: String(values.get("notes") ?? "").trim() });
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog ocr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-review-title"
      >
        <header>
          <div>
            <p className="eyebrow">Control humano obligatorio</p>
            <h2 id="ocr-review-title">Revisar extracción OCR</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={review.isPending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        {job.isPending && <p className="dialog-helper">Cargando extracción…</p>}
        {job.error && <p className="form-error">{job.error.message}</p>}
        {job.data && (
          <form className="invoice-form" onSubmit={submit}>
            <p className="ocr-confidence">
              Confianza global:{" "}
              <strong>{job.data.overallConfidence ?? "0"} %</strong>. Compara
              cada sugerencia con el documento.
            </p>
            <div className="ocr-fields">
              {reviewFields.map(([key, label]) => {
                const extracted = job.data?.extractedFields?.[key];
                return (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <small>
                      OCR: {extracted?.value ?? "No detectado"}
                      {extracted ? ` · ${extracted.confidence} %` : ""}
                    </small>
                    <input
                      name={key}
                      defaultValue={extracted?.value ?? ""}
                      maxLength={500}
                    />
                  </label>
                );
              })}
            </div>
            <label className="field">
              <span>Nota de revisión</span>
              <textarea
                name="notes"
                required
                maxLength={1000}
                defaultValue="Documento contrastado con el original."
              />
            </label>
            {review.error && (
              <p className="form-error" role="alert">
                {review.error.message}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onClose}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="primary-button compact"
                disabled={review.isPending}
              >
                {review.isPending ? "Guardando…" : "Confirmar revisión humana"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function ocrStatusLabel(status: PurchaseOcrJob["status"]) {
  return {
    PENDING: "En cola",
    PROCESSING: "Procesando",
    REVIEW_REQUIRED: "Revisión requerida",
    REVIEWED: "Revisado",
    FAILED: "Fallido",
  }[status];
}

function formatFileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function ocrPollInterval(query: { state: { data?: unknown } }) {
  const jobs = query.state.data as PurchaseOcrJob[] | undefined;
  return jobs?.some((job) => ["PENDING", "PROCESSING"].includes(job.status))
    ? 1_000
    : false;
}

function ApprovalDialog({
  purchase,
  onClose,
  onApproved,
}: {
  purchase: Purchase;
  onClose(): void;
  onApproved(purchase: Purchase): Promise<void>;
}) {
  const sequences = useQuery({
    queryKey: ["document-sequences"],
    queryFn: () => requestJson<DocumentSequence[]>("/api/document-sequences"),
  });
  const approve = useMutation({
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
            body: JSON.stringify({ documentType: "PURCHASE_INVOICE", series }),
          },
        );
        selectedId = created.id;
      }
      const storageName = `pastagansa:approve:${purchase.id}`;
      const key = approvalKey(purchase.id, sessionStorage.getItem(storageName));
      sessionStorage.setItem(storageName, key);
      const result = await requestJson<Purchase>(
        `/api/purchases/${purchase.id}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sequenceId: selectedId, idempotencyKey: key }),
        },
      );
      sessionStorage.removeItem(storageName);
      return result;
    },
    onSuccess: onApproved,
  });
  const active =
    sequences.data?.filter(
      (sequence) =>
        sequence.active && sequence.documentType === "PURCHASE_INVOICE",
    ) ?? [];
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    approve.mutate({
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
        aria-labelledby="approval-title"
      >
        <header>
          <div>
            <p className="eyebrow">Confirmación</p>
            <h2 id="approval-title">Aprobar compra</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={approve.isPending}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>
        <form className="invoice-form" onSubmit={submit}>
          <p className="issue-warning">
            Al aprobar se congelan los importes, se asigna el registro de
            recepción y se generan el asiento y el libro de IVA.
          </p>
          <div className="issue-amount">
            <span>Total a aprobar</span>
            <strong>{formatMoney(purchase.total, purchase.currency)}</strong>
          </div>
          {active.length > 0 ? (
            <label className="field">
              <span>Serie de recepción</span>
              <select name="sequenceId" required defaultValue="">
                <option value="" disabled>
                  Selecciona una serie
                </option>
                {active.map((sequence) => (
                  <option key={sequence.id} value={sequence.id}>
                    {sequence.series}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>Nueva serie de recepción</span>
              <input name="series" required maxLength={30} placeholder="RC" />
            </label>
          )}
          {sequences.error && (
            <p className="form-error">{sequences.error.message}</p>
          )}
          {approve.error && (
            <p className="form-error" role="alert">
              {approve.error.message}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={approve.isPending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="primary-button compact"
              disabled={approve.isPending || sequences.isPending}
            >
              {approve.isPending ? "Aprobando…" : "Aprobar definitivamente"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function PaymentsPanel({ purchase }: { purchase: Purchase }) {
  const queryClient = useQueryClient();
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const payments = useQuery({
    queryKey: ["purchase-payments", purchase.id],
    queryFn: () =>
      requestJson<SupplierPayment[]>(`/api/purchases/${purchase.id}/payments`),
  });
  const record = useMutation({
    mutationFn: async (payload: PaymentInput) => {
      const storageName = `pastagansa:supplier-payment:${purchase.id}`;
      const key = supplierPaymentKey(
        purchase.id,
        sessionStorage.getItem(storageName),
      );
      sessionStorage.setItem(storageName, key);
      const result = await requestJson<SupplierPayment>(
        `/api/purchases/${purchase.id}/payments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, idempotencyKey: key }),
        },
      );
      sessionStorage.removeItem(storageName);
      return result;
    },
    onSuccess: async (payment) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["purchase", purchase.id] }),
        queryClient.invalidateQueries({
          queryKey: ["purchase-payments", purchase.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["purchases"] }),
      ]);
      setRecording(false);
      setNotice(
        `Pago de ${formatMoney(payment.amount, payment.currency)} registrado.`,
      );
    },
  });
  return (
    <section
      className="payments-panel"
      aria-labelledby="supplier-payments-title"
    >
      <header>
        <div>
          <p className="eyebrow">Tesorería</p>
          <h2 id="supplier-payments-title">Pagos</h2>
          <p>
            Saldo pendiente:{" "}
            {formatMoney(purchase.amountDue, purchase.currency)}
          </p>
        </div>
        {Number(purchase.amountDue) > 0 && (
          <button
            className="primary-button compact"
            onClick={() => setRecording(true)}
          >
            Registrar pago
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
      {payments.error && (
        <div className="inline-error" role="alert">
          <strong>No se pudieron cargar los pagos</strong>
          <p>{payments.error.message}</p>
        </div>
      )}
      {payments.isPending && <p className="dialog-helper">Cargando pagos…</p>}
      {payments.data?.length === 0 && (
        <div className="payments-empty">
          <strong>Sin pagos registrados</strong>
          <p>Registra el pago cuando salga de tu cuenta.</p>
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
          purchase={purchase}
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
  purchase,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  purchase: Purchase;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: PaymentInput): void;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      amount: Number(values.get("amount")),
      paidAt: String(values.get("paidAt")),
      method: String(values.get("method")) as PaymentInput["method"],
      reference: String(values.get("reference") ?? "").trim() || undefined,
    });
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog payment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="supplier-payment-title"
      >
        <header>
          <div>
            <p className="eyebrow">Salida de tesorería</p>
            <h2 id="supplier-payment-title">Registrar pago</h2>
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
            <strong>
              {formatMoney(purchase.amountDue, purchase.currency)}
            </strong>
          </div>
          <div className="payment-fields">
            <label className="field">
              <span>Importe</span>
              <input
                name="amount"
                type="number"
                required
                min="0.01"
                max={purchase.amountDue}
                step="0.01"
                defaultValue={Number(purchase.amountDue).toFixed(2)}
              />
            </label>
            <label className="field">
              <span>Fecha del pago</span>
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
              <input name="reference" maxLength={240} />
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
              {pending ? "Registrando…" : "Confirmar pago"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function TracePanel({ purchase }: { purchase: Purchase }) {
  const trace = useQuery({
    queryKey: ["purchase-trace", purchase.id],
    queryFn: () =>
      requestJson<PurchaseTrace>(`/api/purchases/${purchase.id}/trace`),
  });
  const sum = (values: object[], field: string) =>
    String(
      values.reduce(
        (total, value) =>
          total + Number((value as Record<string, string>)[field]),
        0,
      ),
    );
  return (
    <section
      className="trace-panel"
      id="trazabilidad"
      aria-labelledby="purchase-trace-title"
    >
      <header>
        <p className="eyebrow">Trazabilidad</p>
        <h2 id="purchase-trace-title">Impacto fiscal y contable</h2>
        <p>Registros generados automáticamente al aprobar.</p>
      </header>
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
                        sum(trace.data.journalEntry.lines, "debit"),
                        purchase.currency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Haber</dt>
                    <dd>
                      {formatMoney(
                        sum(trace.data.journalEntry.lines, "credit"),
                        purchase.currency,
                      )}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <strong>No encontrado</strong>
            )}
          </article>
          <article>
            <span>Libro de IVA recibido</span>
            {trace.data.taxEntry ? (
              <>
                <strong>{trace.data.taxEntry.documentNumber}</strong>
                <small>
                  {formatInvoiceDate(trace.data.taxEntry.taxPointDate)}
                </small>
                <dl>
                  <div>
                    <dt>Base</dt>
                    <dd>
                      {formatMoney(
                        sum(trace.data.taxEntry.amounts, "taxableBase"),
                        purchase.currency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Cuota</dt>
                    <dd>
                      {formatMoney(
                        sum(trace.data.taxEntry.amounts, "taxAmount"),
                        purchase.currency,
                      )}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <strong>No encontrado</strong>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "No se pudo completar la operación.");
  return body;
}

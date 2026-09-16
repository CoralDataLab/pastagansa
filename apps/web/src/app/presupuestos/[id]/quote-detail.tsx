"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect } from "react";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { CommercialTimeline } from "@/components/commercial-timeline";
import { formatMoney } from "@/lib/catalog";
import { deliveryRetryStorageKey } from "@/lib/delivery-retry";
import { formatInvoiceDate } from "@/lib/invoices";
import {
  quoteCode,
  quoteEmailKey,
  quoteStatusLabel,
  type QuoteEmailCapability,
  type QuoteEmailDelivery,
  type QuoteEmailInput,
  type Quote,
  type QuoteInput,
  type QuoteStatus,
} from "@/lib/quotes";
import { QuoteDialog } from "../quotes-view";

type StatusAction = { status: QuoteStatus; label: string; primary?: boolean };

const actions: Partial<Record<QuoteStatus, StatusAction[]>> = {
  DRAFT: [
    { status: "SENT", label: "Marcar como enviado", primary: true },
    { status: "CANCELLED", label: "Cancelar" },
  ],
  SENT: [
    { status: "ACCEPTED", label: "Registrar aceptación", primary: true },
    { status: "REJECTED", label: "Registrar rechazo" },
    { status: "EXPIRED", label: "Marcar caducado" },
    { status: "CANCELLED", label: "Cancelar" },
  ],
};

export function QuoteDetail({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [converting, setConverting] = useState(false);
  const quote = useQuery({
    queryKey: ["quote", id],
    queryFn: () => requestJson<Quote>(`/api/quotes/${id}`),
    retry: false,
  });
  const updateQuote = useMutation({
    mutationFn: (payload: QuoteInput) =>
      requestJson<Quote>(`/api/quotes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["quote", id], updated);
      await queryClient.invalidateQueries({ queryKey: ["quotes"] });
      setEditing(false);
      setNotice("Los cambios del presupuesto se han guardado.");
    },
  });
  const changeStatus = useMutation({
    mutationFn: ({ status, expectedStatus }: { status: QuoteStatus; expectedStatus: QuoteStatus }) =>
      requestJson<Quote>(`/api/quotes/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, expectedStatus }),
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["quote", id], updated);
      await queryClient.invalidateQueries({ queryKey: ["quotes"] });
      setNotice(`El presupuesto ahora figura como ${quoteStatusLabel(updated.status).toLowerCase()}.`);
    },
  });
  const convertQuote = useMutation({
    mutationFn: (input: { issueDate: string; dueDate?: string }) =>
      requestJson<{ id: string; draftCode: string; status: string }>(`/api/quotes/${id}/convert-to-invoice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: async (invoice) => {
      queryClient.setQueryData<Quote>(["quote", id], (current) =>
        current
          ? {
              ...current,
              status: "CONVERTED",
              convertedInvoice: invoice,
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["quotes"] });
      router.push(`/facturas/${invoice.id}`);
    },
  });

  if (quote.isPending)
    return (
      <AppShell active="presupuestos">
        <section className="detail-loading" aria-live="polite"><div className="spinner" /><p>Cargando presupuesto…</p></section>
      </AppShell>
    );
  if (quote.error)
    return (
      <AppShell active="presupuestos">
        <section className="detail-error">
          <p className="eyebrow">No se pudo abrir</p>
          <h1>Presupuesto no disponible</h1>
          <p>{quote.error.message}</p>
          <Link className="primary-link" href="/presupuestos">Volver a presupuestos</Link>
        </section>
      </AppShell>
    );

  const document = quote.data;
  const availableActions = actions[document.status] ?? [];
  return (
    <AppShell active="presupuestos">
      <section className="detail-heading">
        <div>
          <Link className="back-link" href="/presupuestos">← Presupuestos</Link>
          <p className="eyebrow">Propuesta comercial</p>
          <h1>{quoteCode(document.code)}</h1>
          <p>{document.customerLegalName}</p>
        </div>
        <div className="detail-actions">
          {document.status === "DRAFT" && (
            <button className="secondary-button" onClick={() => setEditing(true)}>Editar borrador</button>
          )}
          {document.convertedInvoice ? (
            <Link className="primary-link compact" href={`/facturas/${document.convertedInvoice.id}`}>
              Ver factura creada
            </Link>
          ) : document.status === "ACCEPTED" ? (
            <button className="primary-button compact" onClick={() => setConverting(true)}>
              Crear factura borrador
            </button>
          ) : null}
          <a className="secondary-button" href={`/api/quotes/${id}/pdf`} download>Descargar PDF</a>
          {availableActions.map((action) => (
            <button
              key={action.status}
              className={action.primary ? "primary-button compact" : "secondary-button"}
              disabled={changeStatus.isPending}
              onClick={() => changeStatus.mutate({ status: action.status, expectedStatus: document.status })}
            >
              {changeStatus.isPending && changeStatus.variables?.status === action.status ? "Guardando…" : action.label}
            </button>
          ))}
        </div>
      </section>
      {notice && (
        <div className="notice" role="status"><span>✓</span>{notice}<button onClick={() => setNotice("")} aria-label="Cerrar aviso">×</button></div>
      )}
      {changeStatus.error && (
        <div className="inline-error" role="alert"><strong>No se pudo cambiar el estado</strong><p>{changeStatus.error.message}</p></div>
      )}
      <section className="invoice-summary-grid">
        <article className="summary-card"><span>Estado</span><strong>{quoteStatusLabel(document.status)}</strong></article>
        <article className="summary-card"><span>Fecha</span><strong>{formatInvoiceDate(document.issueDate)}</strong></article>
        <article className="summary-card"><span>Válido hasta</span><strong>{formatInvoiceDate(document.validUntil)}</strong></article>
        <article className="summary-card total-card"><span>Total</span><strong>{formatMoney(document.total, document.currency)}</strong></article>
      </section>
      <section className="invoice-detail-panel">
        <header>
          <div><h2>Conceptos</h2><p>{document.lines?.length ?? 0} líneas confirmadas por el API</p></div>
        </header>
        <div className="table-scroll">
          <table className="data-table invoice-lines-table">
            <thead><tr><th>Descripción</th><th>Cantidad</th><th>Precio</th><th>Descuento</th><th>IVA</th><th>Total</th></tr></thead>
            <tbody>
              {document.lines?.map((line) => (
                <tr key={line.id}>
                  <td><strong>{line.description}</strong></td>
                  <td>{formatQuantity(line.quantity)}</td>
                  <td className="money-cell">{formatMoney(line.unitPrice, document.currency)}</td>
                  <td>{Number(line.discountPct)} %</td>
                  <td>{Number(line.taxRate)} %</td>
                  <td className="money-cell">{formatMoney(line.totalAmount, document.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="invoice-totals">
          <span>Base antes de descuentos <strong>{formatMoney(document.subtotal, document.currency)}</strong></span>
          <span>Descuentos <strong>− {formatMoney(document.discountTotal, document.currency)}</strong></span>
          <span>IVA <strong>{formatMoney(document.taxTotal, document.currency)}</strong></span>
          <span className="grand-total">Total <strong>{formatMoney(document.total, document.currency)}</strong></span>
        </div>
        {document.notes && <p className="invoice-notes"><strong>Condiciones y notas:</strong> {document.notes}</p>}
      </section>
      {(document.status === "DRAFT" || document.status === "SENT") && <QuoteEmailPanel quote={document} />}
      <CommercialTimeline endpoint={`/api/quotes/${document.id}/commercial-events`} canManage />
      {editing && (
        <QuoteDialog
          initial={document}
          pending={updateQuote.isPending}
          error={updateQuote.error?.message}
          onClose={() => { setEditing(false); updateQuote.reset(); }}
          onSubmit={(payload) => updateQuote.mutate(payload)}
        />
      )}
      {converting && (
        <ConversionDialog
          pending={convertQuote.isPending}
          error={convertQuote.error?.message}
          onClose={() => { setConverting(false); convertQuote.reset(); }}
          onSubmit={(input) => convertQuote.mutate(input)}
        />
      )}
    </AppShell>
  );
}

function QuoteEmailPanel({ quote }: { quote: Quote }) {
  const queryClient = useQueryClient();
  const [recipient, setRecipient] = useState(quote.customerEmail ?? "");
  const [subject, setSubject] = useState(`Presupuesto ${quoteCode(quote.code)}`);
  const capability = useQuery({
    queryKey: ["quote-email-capability"],
    queryFn: () => requestJson<QuoteEmailCapability>("/api/quotes/email-capability"),
  });
  const deliveries = useQuery({
    queryKey: ["quote-email-deliveries", quote.id],
    queryFn: () => requestJson<QuoteEmailDelivery[]>(`/api/quotes/${quote.id}/email-deliveries`),
    refetchInterval: (query) => query.state.data?.some((delivery) => delivery.status === "PENDING" || delivery.status === "PROCESSING") ? 5_000 : false,
  });
  const send = useMutation({
    mutationFn: (input: QuoteEmailInput) => {
      const storageName = deliveryRetryStorageKey(
        "quote",
        quote.id,
        input.recipient,
        input.subject ?? "",
      );
      const key = quoteEmailKey(quote.id, sessionStorage.getItem(storageName));
      sessionStorage.setItem(storageName, key);
      return requestJson<QuoteEmailDelivery>(`/api/quotes/${quote.id}/email`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, idempotencyKey: key }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["quote-email-deliveries", quote.id] });
      await queryClient.invalidateQueries({ queryKey: ["quote", quote.id] });
      await queryClient.invalidateQueries({ queryKey: ["quotes"] });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send.mutate({ recipient, subject: subject || undefined });
  }
  return <section className="invoice-detail-panel">
    <header><div><h2>Enviar por email</h2><p>Adjunta el PDF guardado del presupuesto. El estado cambia a enviado solo cuando SMTP lo acepta.</p></div></header>
    {capability.data?.enabled === false ? <p className="notice">Correo no configurado. Puedes descargar el PDF y enviarlo desde tu cliente habitual.</p> : <form className="contact-form" onSubmit={submit}>
      <label className="field"><span>Destinatario</span><input type="email" required maxLength={320} value={recipient} onChange={(event) => setRecipient(event.target.value)} /></label>
      <label className="field"><span>Asunto</span><input maxLength={300} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
      <div className="full"><button className="primary-button compact" disabled={send.isPending || capability.isPending} type="submit">{send.isPending ? "Encolando…" : "Enviar presupuesto"}</button></div>
    </form>}
    {send.error && <p className="form-error" role="alert">{send.error.message}</p>}
    {deliveries.data?.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Destinatario</th><th>Asunto</th><th>Estado</th><th>Intentos</th></tr></thead><tbody>{deliveries.data.map((delivery) => <tr key={delivery.id}><td>{delivery.recipient}</td><td>{delivery.subject}</td><td>{delivery.status}</td><td>{delivery.attempts}</td></tr>)}</tbody></table></div> : null}
  </section>;
}

function ConversionDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: { issueDate: string; dueDate?: string }): void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onSubmit({
      issueDate: String(values.get("issueDate")),
      dueDate: String(values.get("dueDate") ?? "") || undefined,
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section className="dialog payment-dialog" role="dialog" aria-modal="true" aria-labelledby="conversion-title">
        <header>
          <div><p className="eyebrow">Presupuesto aceptado</p><h2 id="conversion-title">Crear factura borrador</h2></div>
          <button className="icon-button" onClick={onClose} disabled={pending} aria-label="Cerrar">×</button>
        </header>
        <form className="invoice-form" onSubmit={submit}>
          <p className="dialog-helper">Se copiarán el cliente, los conceptos, impuestos y condiciones. Podrás revisar el borrador antes de emitirlo.</p>
          <div className="payment-fields">
            <label className="field"><span>Fecha de factura</span><input name="issueDate" type="date" defaultValue={today()} required /></label>
            <label className="field"><span>Vencimiento (opcional)</span><input name="dueDate" type="date" min={today()} /></label>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={pending}>Cancelar</button>
            <button type="submit" className="primary-button compact" disabled={pending}>{pending ? "Creando…" : "Crear factura"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "No se pudo completar la operación.");
  return body;
}

function formatQuantity(value: string) {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 3 }).format(Number(value));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

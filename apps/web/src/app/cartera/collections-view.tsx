"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { PaymentReminderDialog, type ReminderTarget } from "@/components/payment-reminder-dialog";
import {
  bucketLabels,
  collectionAmount,
  collectionFilters,
  collectionSearch,
  overdueTotal,
  type CollectionInvoice,
  type CollectionsFilters,
  type CollectionsPage,
  type CollectionsSummary,
} from "@/lib/collections";
import {
  formatInvoiceDate,
  paymentKey,
  todayIso,
  type PaymentInput,
} from "@/lib/invoices";

type TimelineEvent = {
  id: string;
  type:
    | "SENT"
    | "DELIVERY_FAILED"
    | "ACCEPTED"
    | "REJECTED"
    | "DISPUTED"
    | "PARTIALLY_PAID"
    | "PAID"
    | "PAYMENT_PROMISED"
    | "NOTE";
  source: string;
  effectiveAt: string;
  receivedAt: string;
  comment: string | null;
};
type TimelinePage = { data: TimelineEvent[]; nextCursor: string | null };

const eventLabels: Record<TimelineEvent["type"], string> = {
  SENT: "Enviado",
  DELIVERY_FAILED: "Entrega fallida",
  ACCEPTED: "Aceptado",
  REJECTED: "Rechazado",
  DISPUTED: "En disputa",
  PARTIALLY_PAID: "Cobro parcial",
  PAID: "Cobrado",
  PAYMENT_PROMISED: "Promesa de pago",
  NOTE: "Nota interna",
};

export function CollectionsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const filtersKey = searchParams.toString();
  const filters = useMemo(
    () => collectionFilters(new URLSearchParams(filtersKey)),
    [filtersKey],
  );
  const [selected, setSelected] = useState<CollectionInvoice>();
  const [selectedReminderIds, setSelectedReminderIds] = useState<string[]>([]);
  const [reminderTargets, setReminderTargets] = useState<ReminderTarget[] | null>(null);
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [notice, setNotice] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingFiltersRef = useRef(filters);

  useEffect(() => {
    pendingFiltersRef.current = filters;
  }, [filters]);

  const invoices = useQuery({
    queryKey: ["collections", filters],
    queryFn: () =>
      requestJson<CollectionsPage>(
        `/api/collections/invoices?${collectionSearch(filters)}`,
      ),
  });
  const summary = useQuery({
    queryKey: ["collections-summary", filters.asOf, filters.text],
    queryFn: () =>
      requestJson<CollectionsSummary>(
        `/api/collections/summary?${collectionSearch(filters, false)}`,
      ),
  });
  const events = useQuery({
    queryKey: ["commercial-events", selected?.id],
    queryFn: () =>
      requestJson<TimelinePage>(
        `/api/invoices/${selected!.id}/commercial-events`,
      ),
    enabled: Boolean(selected),
  });
  const recordEvent = useMutation({
    mutationFn: (payload: {
      type: "PAYMENT_PROMISED" | "DISPUTED" | "NOTE";
      comment?: string;
    }) =>
      requestJson<TimelineEvent>(
        `/api/invoices/${selected!.id}/commercial-events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...payload,
            source: "USER",
            effectiveAt: new Date().toISOString(),
          }),
        },
      ),
    onSuccess: async (event) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["collections"] }),
        queryClient.invalidateQueries({ queryKey: ["collections-summary"] }),
        queryClient.invalidateQueries({
          queryKey: ["commercial-events", selected?.id],
        }),
      ]);
      setNotice(`${eventLabels[event.type]} registrada en la cronología.`);
    },
  });
  const recordPayment = useMutation({
    mutationFn: async (payload: PaymentInput) => {
      const invoice = selected!;
      const storageName = `pastagansa:payment:${invoice.id}`;
      const key = paymentKey(invoice.id, sessionStorage.getItem(storageName));
      sessionStorage.setItem(storageName, key);
      try {
        return await requestJson<{ amount: string; currency: string }>(
          `/api/invoices/${invoice.id}/payments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, idempotencyKey: key }),
          },
        );
      } finally {
        sessionStorage.removeItem(storageName);
      }
    },
    onSuccess: async (payment) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["collections"] }),
        queryClient.invalidateQueries({ queryKey: ["collections-summary"] }),
        queryClient.invalidateQueries({
          queryKey: ["commercial-events", selected?.id],
        }),
      ]);
      setRecordingPayment(false);
      setSelected(undefined);
      setNotice(
        `Cobro de ${collectionAmount(payment.amount, payment.currency)} registrado.`,
      );
    },
  });

  function updateFilters(patch: Partial<CollectionsFilters>) {
    const next = { ...pendingFiltersRef.current, ...patch };
    pendingFiltersRef.current = next;
    const params = new URLSearchParams();
    if (next.asOf) params.set("asOf", next.asOf);
    if (next.bucket) params.set("bucket", next.bucket);
    if (next.status) params.set("status", next.status);
    if (next.text.trim()) params.set("text", next.text.trim());
    router.replace(
      (params.size ? `${pathname}?${params}` : pathname) as Route,
      { scroll: false },
    );
    setSelected(undefined);
    setSelectedReminderIds([]);
  }
  function openDetails(invoice: CollectionInvoice, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setSelected(invoice);
  }
  function closeDetails() {
    setSelected(undefined);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <AppShell active="cartera">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Ventas · Cobros</p>
          <h1>Cartera</h1>
          <p>
            Prioriza los saldos pendientes y conserva cada compromiso junto a la
            factura.
          </p>
        </div>
        <a
          className="secondary-button"
          href={`/api/collections/invoices.csv?${collectionSearch(filters)}`}
        >
          Exportar CSV
        </a>
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
      <CollectionsSummaryCards
        data={summary.data}
        loading={summary.isPending}
      />
      <section className="collections-filters" aria-label="Filtros de cartera">
        <form
          key={filters.text}
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            updateFilters({
              text: String(new FormData(event.currentTarget).get("text") ?? ""),
            });
          }}
        >
          <input
            name="text"
            defaultValue={filters.text}
            placeholder="Cliente o número de factura"
            aria-label="Buscar en cartera"
          />
          <button type="submit">Buscar</button>
        </form>
        <label className="field">
          <span>Fecha de referencia</span>
          <input
            type="date"
            value={filters.asOf}
            onChange={(event) => updateFilters({ asOf: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Tramo</span>
          <select
            value={filters.bucket}
            onChange={(event) =>
              updateFilters({
                bucket: event.target.value as CollectionsFilters["bucket"],
              })
            }
          >
            <option value="">Todos los tramos</option>
            {Object.entries(bucketLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Situación</span>
          <select
            value={filters.status}
            onChange={(event) =>
              updateFilters({
                status: event.target.value as CollectionsFilters["status"],
              })
            }
          >
            <option value="">Todas</option>
            <option value="OPEN">Abiertas</option>
            <option value="PROMISED">Con promesa</option>
            <option value="DISPUTED">En disputa</option>
          </select>
        </label>
      </section>
      <section
        className="data-panel collections-panel"
        aria-labelledby="collections-title"
      >
        <div className="data-toolbar">
          <div>
            <h2 id="collections-title">Facturas pendientes</h2>
            <p>
              {invoices.data
                ? `${invoices.data.data.length} facturas · referencia ${formatInvoiceDate(invoices.data.asOf)}`
                : "Cargando cartera…"}
            </p>
          </div>
          {!!selectedReminderIds.length && (
            <button
              className="primary-button compact"
              onClick={() => setReminderTargets((invoices.data?.data ?? []).filter((invoice) => selectedReminderIds.includes(invoice.id)).map((invoice) => ({ id: invoice.id, number: invoice.fullNumber ?? invoice.draftCode })))}
            >
              Preparar recordatorio ({selectedReminderIds.length})
            </button>
          )}
        </div>
        {invoices.isPending && <LoadingState />}
        {invoices.error && (
          <ErrorState
            message={invoices.error.message}
            onRetry={() => void invoices.refetch()}
          />
        )}
        {invoices.data?.data.length === 0 && (
          <div className="empty-state">
            <span>€</span>
            <h3>No hay saldos para estos filtros</h3>
            <p>
              Prueba a ampliar la búsqueda o cambia el tramo de vencimiento.
            </p>
          </div>
        )}
        {!!invoices.data?.data.length && (
          <CollectionsTable
            items={invoices.data.data}
            onOpen={openDetails}
            selectedIds={selectedReminderIds}
            onToggleReminder={(invoiceId, checked) => setSelectedReminderIds((ids) => checked ? [...new Set([...ids, invoiceId])] : ids.filter((id) => id !== invoiceId))}
          />
        )}
      </section>
      {selected && (
        <CollectionDrawer
          invoice={selected}
          events={events}
          eventError={recordEvent.error?.message}
          eventPending={recordEvent.isPending}
          paymentError={recordPayment.error?.message}
          paymentPending={recordPayment.isPending}
          onClose={closeDetails}
          onRecordEvent={(type, comment) =>
            recordEvent.mutate({ type, comment })
          }
          onRecordPayment={() => setRecordingPayment(true)}
          onPrepareReminder={() => setReminderTargets([{ id: selected.id, number: selected.fullNumber ?? selected.draftCode }])}
        />
      )}
      {recordingPayment && selected && (
        <RecordPaymentDialog
          invoice={selected}
          pending={recordPayment.isPending}
          error={recordPayment.error?.message}
          onClose={() => {
            setRecordingPayment(false);
            recordPayment.reset();
          }}
          onSubmit={(input) => recordPayment.mutate(input)}
        />
      )}
      {reminderTargets && (
        <PaymentReminderDialog
          targets={reminderTargets}
          mode={reminderTargets.length === 1 ? "single" : "batch"}
          onClose={() => setReminderTargets(null)}
          onQueued={async (result) => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["collections"] }),
              queryClient.invalidateQueries({ queryKey: ["commercial-events", selected?.id] }),
            ]);
            setReminderTargets(null);
            setSelectedReminderIds([]);
            setNotice(`${result.queued} recordatorio${result.queued === 1 ? "" : "s"} preparado${result.queued === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} excluido${result.skipped === 1 ? "" : "s"}.` : "."}`);
          }}
        />
      )}
    </AppShell>
  );
}

function CollectionsSummaryCards({
  data,
  loading,
}: {
  data?: CollectionsSummary;
  loading: boolean;
}) {
  const amount = (value: string) =>
    data ? collectionAmount(value, data.currency) : "—";
  return (
    <section className="collections-summary" aria-label="Resumen de cartera">
      <article>
        <span>Por vencer</span>
        <strong>{data ? amount(data.buckets.DUE_THIS_WEEK) : "—"}</strong>
        <small>Vencimiento esta semana</small>
      </article>
      <article className="attention">
        <span>Vencido</span>
        <strong>{data ? amount(overdueTotal(data)) : "—"}</strong>
        <small>
          {data
            ? `${data.count} facturas con saldo`
            : loading
              ? "Calculando…"
              : ""}
        </small>
      </article>
      <article>
        <span>Prometido</span>
        <strong>{data ? amount(data.operational.promised) : "—"}</strong>
        <small>Requiere confirmación</small>
      </article>
      <article>
        <span>En disputa</span>
        <strong>{data ? amount(data.operational.disputed) : "—"}</strong>
        <small>No automatizar recordatorios</small>
      </article>
    </section>
  );
}

function CollectionsTable({
  items,
  onOpen,
  selectedIds,
  onToggleReminder,
}: {
  items: CollectionInvoice[];
  onOpen(invoice: CollectionInvoice, trigger: HTMLButtonElement): void;
  selectedIds: string[];
  onToggleReminder(invoiceId: string, checked: boolean): void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table collections-table">
        <thead>
          <tr>
            <th><span className="sr-only">Seleccionar recordatorio</span></th>
            <th>Cliente</th>
            <th>Factura</th>
            <th>Vencimiento</th>
            <th>Días</th>
            <th>Saldo</th>
            <th>Última acción</th>
            <th>Próxima acción</th>
            <th>
              <span className="sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((invoice) => (
            <tr key={invoice.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(invoice.id)}
                  onChange={(event) => onToggleReminder(invoice.id, event.target.checked)}
                  aria-label={`Preparar recordatorio para ${invoice.fullNumber ?? invoice.draftCode}`}
                />
              </td>
              <td>
                <strong>{invoice.customerLegalName}</strong>
                <small>
                  {collectionStatusLabel(invoice.operationalStatus)}
                </small>
              </td>
              <td>
                <Link className="table-link" href={`/facturas/${invoice.id}`}>
                  {invoice.fullNumber ?? invoice.draftCode}
                </Link>
                <small>
                  {invoice.bucket
                    ? bucketLabels[invoice.bucket]
                    : "Sin vencimiento"}
                </small>
              </td>
              <td>{formatInvoiceDate(invoice.dueDate)}</td>
              <td className={invoice.daysOverdue ? "overdue-days" : ""}>
                {invoice.daysOverdue || "—"}
              </td>
              <td className="money-cell">
                {collectionAmount(invoice.amountDue, invoice.currency)}
              </td>
              <td>
                {invoice.lastEvent ? (
                  <>
                    <strong>{eventLabels[invoice.lastEvent.type]}</strong>
                    <small>
                      {formatInvoiceDate(invoice.lastEvent.effectiveAt)}
                    </small>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td>{invoice.nextAction ?? "—"}</td>
              <td className="row-actions">
                <button
                  className="secondary-button"
                  onClick={(event) => onOpen(invoice, event.currentTarget)}
                >
                  Gestionar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CollectionDrawer({
  invoice,
  events,
  eventError,
  eventPending,
  paymentError,
  paymentPending,
  onClose,
  onRecordEvent,
  onRecordPayment,
  onPrepareReminder,
}: {
  invoice: CollectionInvoice;
  events: ReturnType<typeof useQuery<TimelinePage>>;
  eventError?: string;
  eventPending: boolean;
  paymentError?: string;
  paymentPending: boolean;
  onClose(): void;
  onRecordEvent(
    type: "PAYMENT_PROMISED" | "DISPUTED" | "NOTE",
    comment?: string,
  ): void;
  onRecordPayment(): void;
  onPrepareReminder(): void;
}) {
  const [action, setAction] = useState<
    "PAYMENT_PROMISED" | "DISPUTED" | "NOTE"
  >("PAYMENT_PROMISED");
  const [comment, setComment] = useState("");
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => drawerRef.current?.focus(), []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onRecordEvent(action, comment.trim() || undefined);
    setComment("");
  }
  return (
    <aside
      ref={drawerRef}
      className="collection-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collection-drawer-title"
      tabIndex={-1}
    >
      <header>
        <div>
          <p className="eyebrow">Gestionar cobro</p>
          <h2 id="collection-drawer-title">
            {invoice.fullNumber ?? invoice.draftCode}
          </h2>
          <p>{invoice.customerLegalName}</p>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Cerrar panel"
        >
          ×
        </button>
      </header>
      <dl className="collection-detail">
        <div>
          <dt>Saldo pendiente</dt>
          <dd>{collectionAmount(invoice.amountDue, invoice.currency)}</dd>
        </div>
        <div>
          <dt>Vencimiento</dt>
          <dd>
            {formatInvoiceDate(invoice.dueDate)}
            {invoice.daysOverdue
              ? ` · ${invoice.daysOverdue} días vencida`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Próxima acción</dt>
          <dd>{invoice.nextAction ?? "Sin acción sugerida"}</dd>
        </div>
      </dl>
      <div className="collection-drawer-actions">
        <button
          className="primary-button compact"
          onClick={onRecordPayment}
          disabled={paymentPending}
        >
          Registrar cobro
        </button>
        <button className="secondary-button" onClick={onPrepareReminder}>
          Preparar recordatorio
        </button>
        <Link className="secondary-button" href={`/facturas/${invoice.id}`}>
          Abrir factura
        </Link>
        <Link
          className="secondary-button"
          href={
            `/clientes?search=${encodeURIComponent(invoice.customerLegalName)}` as Route
          }
        >
          Abrir cliente
        </Link>
      </div>
      <section
        className="collection-event-form"
        aria-labelledby="collection-event-title"
      >
        <h3 id="collection-event-title">Registrar seguimiento</h3>
        <form onSubmit={submit}>
          <label className="field">
            <span>Acción</span>
            <select
              value={action}
              onChange={(event) =>
                setAction(event.target.value as typeof action)
              }
            >
              <option value="PAYMENT_PROMISED">Promesa de pago</option>
              <option value="DISPUTED">Marcar en disputa</option>
              <option value="NOTE">Nota interna</option>
            </select>
          </label>
          <label className="field">
            <span>Comentario</span>
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Contexto para el próximo seguimiento"
            />
          </label>
          <button
            className="secondary-button"
            type="submit"
            disabled={eventPending}
          >
            {eventPending ? "Guardando…" : "Guardar en cronología"}
          </button>
        </form>
        {eventError && (
          <p className="form-error" role="alert">
            {eventError}
          </p>
        )}
      </section>
      <section
        className="collection-timeline"
        aria-labelledby="collection-timeline-title"
      >
        <h3 id="collection-timeline-title">Cronología</h3>
        {events.isPending ? (
          <p>Consultando historial…</p>
        ) : events.error ? (
          <p className="form-error" role="alert">
            {events.error.message}
          </p>
        ) : events.data?.data.length ? (
          <ol>
            {events.data.data.map((event) => (
              <li key={event.id}>
                <strong>{eventLabels[event.type]}</strong>
                <span>
                  {formatDateTime(event.effectiveAt)} · {event.source}
                </span>
                {event.comment && <small>{event.comment}</small>}
              </li>
            ))}
          </ol>
        ) : (
          <p>Sin eventos comerciales todavía.</p>
        )}
      </section>
      <p className="collection-reminder">
        Revisa destinatario y contenido antes de enviar cada recordatorio. Si el correo
        no está configurado, conserva el seguimiento aquí y comparte la factura PDF.
      </p>
      {paymentError && (
        <p className="form-error" role="alert">
          {paymentError}
        </p>
      )}
    </aside>
  );
}

function RecordPaymentDialog({
  invoice,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  invoice: CollectionInvoice;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: PaymentInput): void;
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
        aria-labelledby="collection-payment-title"
      >
        <header>
          <div>
            <p className="eyebrow">Nuevo movimiento</p>
            <h2 id="collection-payment-title">Registrar cobro</h2>
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
              {collectionAmount(invoice.amountDue, invoice.currency)}
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
              <input name="reference" maxLength={240} />
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

function LoadingState() {
  return (
    <div className="loading-rows" aria-live="polite">
      <span />
      <span />
      <span />
      <p>Cargando cartera…</p>
    </div>
  );
}
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void;
}) {
  return (
    <div className="inline-error" role="alert">
      <strong>No se pudo cargar la cartera</strong>
      <p>{message}</p>
      <button onClick={onRetry}>Reintentar</button>
    </div>
  );
}
function collectionStatusLabel(status: CollectionInvoice["operationalStatus"]) {
  return {
    OPEN: "Abierta",
    PROMISED: "Promesa de pago",
    DISPUTED: "En disputa",
  }[status];
}
function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => undefined)) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(body?.error ?? "No se pudo completar la operación.");
  return body;
}

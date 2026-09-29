"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { contactPayload, type Contact, type ContactPage } from "@/lib/contacts";

export function ContactsView() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get("search")?.slice(0, 100) ?? "";
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(initialSearch);
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [kind, setKind] = useState<"ALL" | "CUSTOMER" | "SUPPLIER">("ALL");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Contact>();
  const [notice, setNotice] = useState("");

  const contacts = useQuery({
    queryKey: ["contacts", kind, search, cursor],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "20" });
      if (kind !== "ALL") params.set("kind", kind);
      if (search) params.set("search", search);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/contacts?${params}`);
      const body = (await response.json()) as ContactPage & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "No se pudieron cargar los contactos.");
      return body;
    },
  });

  const createContact = useMutation({
    mutationFn: async (payload: ReturnType<typeof contactPayload>) => {
      const duplicate = await findDuplicate(payload);
      if (duplicate) throw new DuplicateContactError(duplicate);
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Contact & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "No se pudo guardar el cliente.");
      return body;
    },
    onSuccess: async (contact) => {
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setCreating(false);
      setNotice(`${contact.legalName} ya está en tu cartera.`);
    },
  });

  const updateContact = useMutation({
    mutationFn: async ({
      id,
      payload,
    }: {
      id: string;
      payload: ReturnType<typeof contactPayload>;
    }) => {
      const response = await fetch(`/api/contacts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Contact & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "No se pudo actualizar el contacto.");
      return body;
    },
    onSuccess: async (contact) => {
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setEditing(undefined);
      setNotice(`${contact.legalName} se ha actualizado.`);
    },
  });

  const archiveContact = useMutation({
    mutationFn: async (contact: Contact) => {
      const response = await fetch(`/api/contacts/${contact.id}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as Contact & { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "No se pudo archivar el contacto.");
      return body;
    },
    onSuccess: async (contact) => {
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
      setEditing(undefined);
      setNotice(`${contact.legalName} se ha archivado.`);
    },
  });

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(searchInput.trim());
    setCursor(undefined);
    setHistory([]);
    setNotice("");
  }

  return (
    <AppShell active="clientes">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Ventas y compras · Maestros</p>
          <h1>Contactos</h1>
          <p>Clientes y proveedores reutilizables en todos tus documentos.</p>
        </div>
        <button
          className="primary-button compact"
          onClick={() => setCreating(true)}
        >
          Nuevo contacto
        </button>
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

      <section className="data-panel" aria-labelledby="contacts-title">
        <div className="data-toolbar">
          <div>
            <h2 id="contacts-title">Cartera activa</h2>
            <p>
              {contacts.data
                ? `${contacts.data.data.length} en esta página`
                : "Cargando…"}
            </p>
          </div>
          <label className="kind-filter">
            <span>Mostrar</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
                setCursor(undefined);
                setHistory([]);
              }}
            >
              <option value="ALL">Todos</option>
              <option value="CUSTOMER">Clientes</option>
              <option value="SUPPLIER">Proveedores</option>
            </select>
          </label>
          <form className="search-form" onSubmit={applySearch} role="search">
            <label className="sr-only" htmlFor="contact-search">
              Buscar contactos
            </label>
            <input
              id="contact-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Nombre, razón social o NIF"
              maxLength={100}
            />
            <button type="submit">Buscar</button>
          </form>
        </div>

        {contacts.isPending && <LoadingRows />}
        {contacts.error && (
          <div className="inline-error" role="alert">
            <strong>No se pudo cargar la cartera</strong>
            <p>{contacts.error.message}</p>
            <button onClick={() => void contacts.refetch()}>Reintentar</button>
          </div>
        )}
        {contacts.data?.data.length === 0 && (
          <div className="empty-state">
            <span>CL</span>
            <h3>
              {search ? "No hay coincidencias" : "Crea tu primer contacto"}
            </h3>
            <p>
              {search
                ? "Prueba con otro nombre o NIF."
                : "Después podrás usarlo como cliente, proveedor o ambos."}
            </p>
            {!search && (
              <button
                className="secondary-button"
                onClick={() => setCreating(true)}
              >
                Nuevo contacto
              </button>
            )}
          </div>
        )}
        {!!contacts.data?.data.length && (
          <ContactsTable contacts={contacts.data.data} onEdit={setEditing} />
        )}

        {(history.length > 0 || contacts.data?.nextCursor) && (
          <div className="pagination" aria-label="Paginación de contactos">
            <button
              disabled={!history.length}
              onClick={() => {
                const previous = history.at(-1);
                setHistory((items) => items.slice(0, -1));
                setCursor(previous);
              }}
            >
              Anterior
            </button>
            <button
              disabled={!contacts.data?.nextCursor}
              onClick={() => {
                setHistory((items) => [...items, cursor]);
                setCursor(contacts.data?.nextCursor ?? undefined);
              }}
            >
              Siguiente
            </button>
          </div>
        )}
      </section>

      {creating && (
        <ContactDialog
          pending={createContact.isPending}
          error={
            createContact.error instanceof DuplicateContactError
              ? undefined
              : createContact.error?.message
          }
          duplicate={
            createContact.error instanceof DuplicateContactError
              ? createContact.error.contact
              : undefined
          }
          onClose={() => {
            setCreating(false);
            createContact.reset();
          }}
          onSubmit={(payload) => createContact.mutate(payload)}
          onEditDuplicate={(contact) => {
            setCreating(false);
            createContact.reset();
            setEditing(contact);
          }}
        />
      )}
      {editing && (
        <ContactDialog
          contact={editing}
          pending={updateContact.isPending || archiveContact.isPending}
          error={updateContact.error?.message ?? archiveContact.error?.message}
          onClose={() => {
            setEditing(undefined);
            updateContact.reset();
            archiveContact.reset();
          }}
          onSubmit={(payload) =>
            updateContact.mutate({ id: editing.id, payload })
          }
          onArchive={() => {
            if (
              window.confirm(
                `¿Archivar ${editing.legalName}? Sus documentos históricos se conservarán.`,
              )
            )
              archiveContact.mutate(editing);
          }}
        />
      )}
    </AppShell>
  );
}

function ContactsTable({
  contacts,
  onEdit,
}: {
  contacts: Contact[];
  onEdit(contact: Contact): void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Cliente</th>
            <th>NIF</th>
            <th>Contacto</th>
            <th>Condiciones</th>
            <th>Tipo</th>
            <th>
              <span className="sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => (
            <tr key={contact.id}>
              <td>
                <strong>{contact.legalName}</strong>
                {contact.tradeName && <small>{contact.tradeName}</small>}
              </td>
              <td>{contact.taxId ?? "—"}</td>
              <td>{contact.email ?? contact.phone ?? "—"}</td>
              <td>
                {contact.paymentTermsDays
                  ? `${contact.paymentTermsDays} días`
                  : "Al contado"}
              </td>
              <td>
                <span className="tag">
                  {contact.isCustomer && contact.isSupplier
                    ? "Cliente · Proveedor"
                    : contact.isCustomer
                      ? "Cliente"
                      : "Proveedor"}
                </span>
              </td>
              <td className="row-actions">
                <button className="text-button" onClick={() => onEdit(contact)}>
                  Editar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContactDialog({
  contact,
  pending,
  error,
  duplicate,
  onClose,
  onSubmit,
  onEditDuplicate,
  onArchive,
}: {
  contact?: Contact;
  pending: boolean;
  error?: string;
  duplicate?: Contact;
  onClose(): void;
  onSubmit(payload: ReturnType<typeof contactPayload>): void;
  onEditDuplicate?(contact: Contact): void;
  onArchive?(): void;
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
    onSubmit(
      contactPayload(Object.fromEntries(new FormData(event.currentTarget))),
    );
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
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-dialog-title"
      >
        <header>
          <div>
            <p className="eyebrow">
              {contact ? "Editar registro" : "Nuevo registro"}
            </p>
            <h2 id="contact-dialog-title">
              {contact ? "Editar contacto" : "Crear contacto"}
            </h2>
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
        <form onSubmit={submit} className="contact-form">
          <label className="field full">
            <span>Razón social *</span>
            <input
              name="legalName"
              required
              maxLength={240}
              autoFocus
              placeholder="Cliente Ejemplo SL"
              defaultValue={contact?.legalName}
            />
          </label>
          <label className="field">
            <span>Nombre comercial</span>
            <input
              name="tradeName"
              maxLength={240}
              placeholder="Cliente Ejemplo"
              defaultValue={contact?.tradeName ?? ""}
            />
          </label>
          <label className="field">
            <span>País fiscal (ISO, 2 letras)</span>
            <input name="taxCountry" required maxLength={2} minLength={2} autoCapitalize="characters" placeholder="ES o IE" defaultValue={contact?.taxCountry ?? "ES"} />
          </label>
          <label className="field">
            <span>Identificador fiscal (NIF / VAT ID)</span>
            <input
              name="taxId"
              maxLength={40}
              autoCapitalize="characters"
              placeholder="B12345674 o IE4276970QH"
              defaultValue={contact?.taxId ?? ""}
            />
            <small>Un ID extranjero se comprueba solo sintácticamente. Confirma su validez fiscal por separado.</small>
          </label>
          <label className="field">
            <span>Correo de facturación</span>
            <input
              name="email"
              type="email"
              maxLength={320}
              placeholder="facturas@cliente.es"
              defaultValue={contact?.email ?? ""}
            />
          </label>
          <label className="field">
            <span>Teléfono</span>
            <input
              name="phone"
              type="tel"
              maxLength={40}
              placeholder="+34 600 000 000"
              defaultValue={contact?.phone ?? ""}
            />
          </label>
          <label className="field">
            <span>Plazo de pago</span>
            <select
              name="paymentTermsDays"
              defaultValue={String(contact?.paymentTermsDays ?? 30)}
            >
              <option value="0">Al contado</option>
              <option value="15">15 días</option>
              <option value="30">30 días</option>
              <option value="60">60 días</option>
              <option value="90">90 días</option>
            </select>
          </label>
          <label className="field">
            <span>Método habitual</span>
            <select
              name="paymentMethod"
              defaultValue={contact?.paymentMethod ?? "BANK_TRANSFER"}
            >
              <option value="BANK_TRANSFER">Transferencia</option>
              <option value="DIRECT_DEBIT">Domiciliación</option>
              <option value="CARD">Tarjeta</option>
              <option value="CASH">Efectivo</option>
              <option value="OTHER">Otro</option>
            </select>
          </label>
          <label className="check-field full">
            <input
              defaultChecked={contact?.isCustomer ?? true}
              name="isCustomer"
              type="checkbox"
            />
            <span>Es cliente</span>
          </label>
          <label className="check-field full">
            <input
              defaultChecked={contact?.isSupplier ?? false}
              name="isSupplier"
              type="checkbox"
            />
            <span>Es proveedor</span>
          </label>
          {duplicate && onEditDuplicate && (
            <div className="duplicate-warning full" role="alert">
              <strong>Este contacto parece existir</strong>
              <span>
                {duplicate.legalName}
                {duplicate.taxId ? ` · ${duplicate.taxId}` : ""} ya figura como{" "}
                {contactKinds(duplicate)}.
              </span>
              <button
                className="secondary-button"
                onClick={() => onEditDuplicate(duplicate)}
                type="button"
              >
                Editar el existente
              </button>
            </div>
          )}
          {error && (
            <p className="form-error full" role="alert">
              {error}
            </p>
          )}
          <footer className="dialog-actions full">
            {contact && onArchive && (
              <button
                type="button"
                className="text-button danger-action"
                onClick={onArchive}
                disabled={pending}
              >
                Archivar contacto
              </button>
            )}
            <button
              type="button"
              className="text-button"
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
              {pending
                ? "Guardando…"
                : contact
                  ? "Guardar cambios"
                  : "Guardar contacto"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="loading-rows" aria-live="polite">
      <span />
      <span />
      <span />
      <p>Cargando clientes…</p>
    </div>
  );
}

async function findDuplicate(
  payload: ReturnType<typeof contactPayload>,
): Promise<Contact | undefined> {
  if (!payload.isCustomer && !payload.isSupplier)
    throw new Error("Indica si el contacto es cliente, proveedor o ambos.");
  const legalName = normalizeMatch(payload.legalName);
  const taxId = payload.taxId ? normalizeMatch(payload.taxId) : undefined;
  const searches = [
    payload.legalName,
    ...(payload.taxId ? [payload.taxId] : []),
  ];
  const pages = await Promise.all(
    searches.map(async (search) => {
      const params = new URLSearchParams({ search, limit: "20" });
      const response = await fetch(`/api/contacts?${params}`);
      return response.ok ? ((await response.json()) as ContactPage).data : [];
    }),
  );
  return pages
    .flat()
    .find(
      (contact) =>
        normalizeMatch(contact.legalName) === legalName ||
        (taxId !== undefined && normalizeMatch(contact.taxId ?? "") === taxId),
    );
}

function normalizeMatch(value: string) {
  return value.trim().toLocaleUpperCase("es-ES");
}

function contactKinds(contact: Contact) {
  if (contact.isCustomer && contact.isSupplier) return "cliente y proveedor";
  return contact.isCustomer ? "cliente" : "proveedor";
}

class DuplicateContactError extends Error {
  constructor(readonly contact: Contact) {
    super("Ya existe un contacto con el mismo nombre o NIF.");
  }
}

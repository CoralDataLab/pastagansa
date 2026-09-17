const defaults = {
  email: "demo@pastagansa.local",
  password: "DemoPastagansa2026!",
  organizationName: "PastaGansa Demo",
  legalName: "PastaGansa Demo SL",
  taxId: "B12345674",
};

const apiUrl = new URL(process.env.DEMO_API_URL ?? "http://127.0.0.1:3000");
const allowRemote = process.env.ALLOW_REMOTE_DEMO_SEED === "1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

if (!loopbackHosts.has(apiUrl.hostname) && !allowRemote) {
  throw new Error(
    `Refusing to seed non-loopback host ${apiUrl.host}. Set ALLOW_REMOTE_DEMO_SEED=1 explicitly if this is an isolated demo environment.`,
  );
}

const credentials = {
  email: process.env.DEMO_EMAIL ?? defaults.email,
  password: process.env.DEMO_PASSWORD ?? defaults.password,
};

async function request(path, { token, tenant, ...init } = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (tenant) {
    headers.set("x-organization-id", tenant.organizationId);
    headers.set("x-company-id", tenant.companyId);
  }
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers,
    cache: "no-store",
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = body?.message ?? body?.error ?? response.statusText;
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${detail}`,
    );
  }
  return body;
}

async function authenticate() {
  const loginResponse = await fetch(new URL("/v1/identity/login", apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  if (loginResponse.ok) return loginResponse.json();
  if (loginResponse.status !== 401) {
    const body = await loginResponse.json().catch(() => undefined);
    throw new Error(
      `Cannot log in demo user: ${loginResponse.status} ${body?.message ?? body?.error ?? loginResponse.statusText}`,
    );
  }
  return request("/v1/identity/register", {
    method: "POST",
    body: JSON.stringify({
      ...credentials,
      organizationName:
        process.env.DEMO_ORGANIZATION_NAME ?? defaults.organizationName,
      legalName: process.env.DEMO_LEGAL_NAME ?? defaults.legalName,
      taxId: process.env.DEMO_TAX_ID ?? defaults.taxId,
    }),
  });
}

async function ensureContact(auth, expected) {
  const page = await request(
    `/v1/contacts?search=${encodeURIComponent(expected.taxId)}&limit=100`,
    auth,
  );
  const existing = page.data.find(
    (contact) => contact.taxId === expected.taxId,
  );
  if (existing) return { state: "existing", value: existing };
  return {
    state: "created",
    value: await request("/v1/contacts", {
      ...auth,
      method: "POST",
      body: JSON.stringify(expected),
    }),
  };
}

async function ensureCatalogItem(auth, expected) {
  const page = await request(
    `/v1/catalog-items?search=${encodeURIComponent(expected.sku)}&limit=100`,
    auth,
  );
  const existing = page.data.find((item) => item.sku === expected.sku);
  if (existing) return { state: "existing", value: existing };
  return {
    state: "created",
    value: await request("/v1/catalog-items", {
      ...auth,
      method: "POST",
      body: JSON.stringify(expected),
    }),
  };
}

async function ensureSequence(auth, sequences, expected) {
  const existing = sequences.find(
    (sequence) =>
      sequence.documentType === expected.documentType &&
      sequence.series === expected.series,
  );
  if (existing) return { state: "existing", value: existing };
  return {
    state: "created",
    value: await request("/v1/document-sequences", {
      ...auth,
      method: "POST",
      body: JSON.stringify(expected),
    }),
  };
}

async function ensureBankAccount(auth) {
  const bankAccounts = await request("/v1/banking/accounts", auth);
  const existing = bankAccounts.find(
    (account) => account.name === "Cuenta demo",
  );
  if (existing) return { state: "existing", value: existing };
  const accounts = await request("/v1/accounting/accounts", auth);
  const ledgerAccount = accounts.find(
    (account) => account.code === "572000" && account.isReconcilable,
  );
  if (!ledgerAccount)
    throw new Error("Default reconcilable account 572000 is missing");
  return {
    state: "created",
    value: await request("/v1/banking/accounts", {
      ...auth,
      method: "POST",
      body: JSON.stringify({
        accountId: ledgerAccount.id,
        name: "Cuenta demo",
        currency: "EUR",
      }),
    }),
  };
}

async function ensureDocumentProfile(auth) {
  const company = await request("/v1/companies/current", auth);
  if (company.documentProfile) return { state: "existing", value: company.documentProfile };
  const updated = await request("/v1/companies/current", {
    ...auth,
    method: "PATCH",
    body: JSON.stringify({ documentProfile: {
      tradeName: "PastaGansa Demo",
      addressLine1: "Calle Demo 12",
      postalCode: "28001",
      city: "Madrid",
      addressCountry: "ES",
      email: "demo@pastagansa.local",
      bankIban: "ES9121000418450200051332",
      paymentInstructions: "Transferencia a la cuenta indicada",
      paymentTerms: "Pago a 30 días",
      documentFooter: "Documento de demostración · datos ficticios",
      primaryColor: "#F71950",
    } }),
  });
  return { state: "created", value: updated.documentProfile };
}

async function ensureLogo(auth) {
  const company = await request("/v1/companies/current", auth);
  if (company.documentLogo) return { state: "existing", value: company.documentLogo };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAABlBMVEX////3GVAVIk7HAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAHUlEQVQ4y2NgJAAYRhXQQAEDHIwqoEzBaIqiqQIAdkkDnXfLkckAAAAASUVORK5CYII=", "base64");
  const form = new FormData();
  form.set("file", new Blob([png], { type: "image/png" }), "logo-demo.png");
  const updated = await request("/v1/companies/current/logo", { ...auth, method: "PUT", body: form });
  return { state: "created", value: updated };
}

async function findDemoInvoice(auth) {
  let cursor;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await request(`/v1/invoices?${query}`, auth);
    const invoice = page.data.find((item) => item.notes === "DEMO-U6-OPERATIVA");
    if (invoice) return invoice;
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

async function ensureDemoInvoice(auth, contactId, sequenceId) {
  const existing = await findDemoInvoice(auth);
  if (existing?.status !== "DRAFT" && existing) return { state: "existing", value: existing };
  const issueDate = new Date();
  const dueDate = new Date(issueDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + 30);
  const draft = existing ?? await request("/v1/invoices", {
      ...auth,
      method: "POST",
      body: JSON.stringify({
        contactId,
        issueDate: issueDate.toISOString().slice(0, 10),
        dueDate: dueDate.toISOString().slice(0, 10),
        notes: "DEMO-U6-OPERATIVA",
        currency: "EUR",
        lines: [{ description: "Servicio de demostración U6", quantity: 2, unitPrice: 75, taxRate: 21 }],
      }),
    });
  const issued = await request(`/v1/invoices/${draft.id}/issue`, {
    ...auth,
    method: "POST",
    headers: { "idempotency-key": "seed-demo-u6-invoice" },
    body: JSON.stringify({ sequenceId }),
  });
  return { state: existing ? "existing" : "created", value: issued };
}

async function ensureDemoPromise(auth, invoiceId) {
  const timeline = await request(`/v1/invoices/${invoiceId}/commercial-events?limit=100`, auth);
  const existing = timeline.data.find((event) => event.externalId === "demo-u6-promise");
  if (existing) return { state: "existing", value: existing };
  const event = await request(`/v1/invoices/${invoiceId}/commercial-events`, {
    ...auth,
    method: "POST",
    body: JSON.stringify({
      type: "PAYMENT_PROMISED",
      source: "USER",
      externalId: "demo-u6-promise",
      effectiveAt: new Date().toISOString(),
      comment: "El cliente demo confirma el pago para el próximo vencimiento.",
    }),
  });
  return { state: "created", value: event };
}

const tokens = await authenticate();
const context = await request("/v1/identity/context", {
  token: tokens.accessToken,
});
const membership = context.memberships.find(({ company }) => company);
if (!membership) throw new Error("Demo user has no active company membership");
const auth = {
  token: tokens.accessToken,
  tenant: {
    organizationId: membership.organization.id,
    companyId: membership.company.id,
  },
};

const customer = await ensureContact(auth, {
  legalName: "Cliente Demo SL",
  taxId: "12345678Z",
  email: "cliente@example.test",
  paymentTermsDays: 30,
  paymentMethod: "BANK_TRANSFER",
  isCustomer: true,
  isSupplier: false,
});
const supplier = await ensureContact(auth, {
  legalName: "Proveedor Demo SA",
  taxId: "A58818501",
  email: "proveedor@example.test",
  paymentTermsDays: 30,
  paymentMethod: "BANK_TRANSFER",
  isCustomer: false,
  isSupplier: true,
});
const service = await ensureCatalogItem(auth, {
  type: "SERVICE",
  sku: "DEMO-SERVICIO",
  name: "Servicio de consultoría",
  description: "Servicio demo para recorrer la primera venta",
  unit: "hora",
  salesPrice: 75,
  currency: "EUR",
  suggestedTaxCode: "ES_VAT_GENERAL_21",
  revenueAccountCode: "700000",
  expenseAccountCode: "600000",
  trackInventory: false,
});
const sequences = await request("/v1/document-sequences", auth);
const invoiceSequence = await ensureSequence(auth, sequences, {
  documentType: "INVOICE",
  series: "DEMO-F",
  startingNumber: 1,
  padding: 4,
});
const purchaseSequence = await ensureSequence(auth, sequences, {
  documentType: "PURCHASE_INVOICE",
  series: "DEMO-C",
  startingNumber: 1,
  padding: 4,
});
const quoteSequence = await ensureSequence(auth, sequences, {
  documentType: "QUOTE",
  series: "DEMO-P",
  startingNumber: 1,
  padding: 4,
});
const bankAccount = await ensureBankAccount(auth);
const documentProfile = await ensureDocumentProfile(auth);
const logo = await ensureLogo(auth);
const demoInvoice = await ensureDemoInvoice(auth, customer.value.id, invoiceSequence.value.id);
const promiseEvent = await ensureDemoPromise(auth, demoInvoice.value.id);

const resources = {
  customer,
  supplier,
  service,
  invoiceSequence,
  purchaseSequence,
  quoteSequence,
  bankAccount,
  documentProfile,
  logo,
  demoInvoice,
  promiseEvent,
};
const created = Object.values(resources).filter(
  ({ state }) => state === "created",
).length;
console.log(
  JSON.stringify(
    {
      demo: {
        email: credentials.email,
        company: membership.company.legalName,
        organization: membership.organization.name,
      },
      result: { created, existing: Object.keys(resources).length - created },
      resources: Object.fromEntries(
        Object.entries(resources).map(([name, resource]) => [
          name,
          { id: resource.value.id, state: resource.state },
        ]),
      ),
    },
    null,
    2,
  ),
);

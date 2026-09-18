# Plan de implementación

## ERP SaaS de gestión, contabilidad y fiscalidad para España

**Versión:** 1.0  
**Fecha de referencia:** 8 de septiembre de 2026  
**Unidad de planificación:** sprints de 2 semanas  
**Objetivo:** entregar un P0 comercial con núcleo de facturación, contabilidad, IVA/IRPF, libros, modelos principales, bancos y SIF/VERI\*FACTU, con arquitectura preparada para crecimiento.

## Estado real de implementación

**Actualizado:** 18 de septiembre de 2026

**Rama de referencia:** `main`
**Criterio:** un elemento solo se marca como completado cuando existe implementación, migración cuando aplica y validación automatizada básica. El estado no sustituye la revisión fiscal, de seguridad ni de producto exigida en este plan.

| Fase                                   | Estado       | Alcance implementado / pendiente relevante                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fase 0 — Descubrimiento y arquitectura | En curso     | Especificaciones funcional, técnica, UI/UX y este plan están versionadas; existe repositorio, Docker local, staging HTTPS y CI con PostgreSQL 17, migraciones, lint, build, 52 pruebas unitarias, pruebas integrales de aislamiento/concurrencia, E2E de Chromium y auditoría de dependencias. La emisión de 100 facturas simultáneas, su idempotencia, inmutabilidad posterior, PDF y outbox transaccional ya están validados en CI con PostgreSQL; el último pipeline completo está verde. Pendientes ADRs y matriz normativa validada.                                                                                                                                                                                                                                                           |
| Fase 1 — Plataforma base               | En curso     | Registro, login, cambio de contraseña y gestión/revocación de sesiones desde la UI; recuperación mediante enlace administrativo de un solo uso cuando no hay SMTP; tokens con sesiones revocables y refresh rotativo protegido contra concurrencia; organización/empresa inicial; RBAC; transacciones por request con contexto RLS forzado; audit log transaccional y append-only; headers de seguridad, rate limit, request IDs, errores/logs estructurados, métricas y OpenAPI. Cuando exista SMTP queda pendiente el autoservicio de recuperación con respuesta no enumerativa y entrega por outbox; también MFA, gestión completa de organizaciones/membresías/roles, archivos/antivirus, trazas distribuidas y backups.                                                                        |
| Fase 2 — Maestros                      | Completada   | Gate superado: contactos cliente/proveedor y catálogo de productos/servicios disponen de CRUD con archivado, permisos, auditoría, aislamiento por empresa, direcciones, condiciones comerciales, cuentas sugeridas, importación CSV atómica, búsqueda y paginación por cursor; estos maestros alimentan documentos comerciales reales. La web ofrece un maestro único de contactos con filtros, roles cliente/proveedor editables y recuperación guiada ante posibles duplicados.                                                                                                                                                                                                                                                                                                                   |
| Fase 3 — Ventas                        | En curso     | Presupuestos completos hasta PDF y transiciones con precondición explícita de estado; borradores, series, emisión idempotente y numeración atómica de facturas validados en PostgreSQL, incluida una prueba de 100 emisiones simultáneas. PDF oficial y outbox transaccional SMTP implementados. Rectificativas con relación, motivo, impacto, serie propia y límites concurrentes. Implementados también vencimientos configurables y cobros manuales idempotentes con reparto, saldo, estados y protección frente a carreras/sobrecobro. La web completa cliente → catálogo → borrador → emisión → PDF → cobro, muestra su trazabilidad fiscal/contable y lo protege con E2E de Chromium en CI. Pendientes SMTP de staging, pedidos, albaranes, recurrencia y devoluciones/cobros multidocumento. |
| Fase 4 — Compras y gastos              | Completada   | Gate obligatorio superado: alta manual y adjuntos; snapshots fiscales y deducibilidad; duplicados, numeración e inmutabilidad; vencimientos, pagos salientes y contabilidad; circuito configurable de uno a cinco aprobadores distintos; y OCR asíncrono en español para PNG/JPEG con evidencia, confianza, reintentos y revisión humana obligatoria. La aprobación final publica Tax Ledger y asiento en la misma transacción. Un proveedor OCR capaz de procesar PDF y el traslado de archivos a object storage con antivirus permanecen como hardening de plataforma y no bloquean el gate funcional de compras.                                                                                                                                                                                 |
| Fase 5 — Motor contable                | Completada   | Gate obligatorio superado: plan PGC inicial y cuentas configurables; reglas por empresa para venta, compra, cobro y pago; ejercicios y periodos; contabilización automática; asientos manuales idempotentes; numeración anual; inmutabilidad posted; reversión; bloqueo; balance de sumas y saldos; diario/mayor exportable; y conciliación bancaria uno-a-uno. Las reglas solo afectan a asientos futuros y PostgreSQL valida evento/rol, clase de cuenta, actividad y tenant. PyG, balance de situación, cierre básico y centros permanecen como Sprint D opcional.                                                                                                                                                                                                                               |
| Fase 6 — Motor fiscal                  | En curso     | Reglas fiscales españolas versionadas e inmutables para IVA general, reducido, superreducido, cero, exento y no sujeto; snapshots por línea; Tax Ledger append-only para facturas emitidas y recibidas, aislado por empresa y publicado transaccionalmente. Las compras registran fechas de emisión, operación, recepción y deducción, IVA soportado y cuota deducible; las rectificativas de venta generan importes negativos vinculados al apunte original. Pendientes recargo de equivalencia, inversión del sujeto pasivo, operaciones intracomunitarias/importaciones/exportaciones, prorrata avanzada, IRPF y validación fiscal exhaustiva.                                                                                                                                                   |
| Fase 9 — Tesorería                     | En curso     | Cuentas bancarias ligadas a cuentas contables conciliables, importación atómica de movimientos normalizados, protección frente a duplicados, bandeja paginada, sugerencias explícitas por importe/fecha/referencia y conciliación uno-a-uno append-only con controles de dirección, importe, cuenta, asiento posted, concurrencia y RLS. Pendientes CSV/Norma 43, saldos, conciliación parcial/combinada, reglas avanzadas y proveedor Open Banking.                                                                                                                                                                                                                                                                                                                                                |
| Fase 10 — SIF/VERI\*FACTU              | En curso     | Las emisiones en modo SIF generan transaccionalmente registros de alta versionados, append-only, aislados por tenant y encadenados por empresa; las nuevas emisiones con `DISABLED` no generan registro ni QR fiscal. Los registros históricos permanecen inmutables. La huella SHA-256 reproduce vectores oficiales AEAT 0.1.2; alta, anulación y subsanación de aviso horario verifican huellas y enlaces. La anulación SIF aislada e idempotente no altera contabilidad ni IVA; un flujo separado revierte ambos para facturas emitidas por operación inexistente. Se conserva la clasificación F1/R1–R5 y la serie rectificativa; R5 espera soporte F2. NO VERI*FACTU solo se permite con entorno AEAT de pruebas y muestra advertencia de falta de conformidad; VERI*FACTU se limita a AEAT pruebas con certificado y outbox: una alta F1 fue aceptada sin errores el 18/09/2026. Las capturas de staging muestran una subsanación horaria y una anulación de alta rechazada aceptadas, con cinco registros en la cadena local verificada. El XML exportado de la anulación se validó con el XSD local y contiene SinRegistroPrevio=S; la respuesta SOAP no se cotejó directamente en la AEAT. Pendientes recuperación general, cobertura XML completa, firma/eventos cuando apliquen, transición de cadena y revisión de conformidad antes de producción. |
| Fases 7–8 y 11–14                      | No iniciadas | No existe todavía implementación de libros/modelos fiscales, reporting, webhooks, hardening, piloto o GA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Hito U — Producto usable               | Completado   | U0–U4 están completadas: existe arranque reproducible, seed demo idempotente, acceso y selector multiempresa validado en servidor, y los recorridos críticos están protegidos por E2E real de Chromium con auditorías WCAG automáticas. U4 ofrece resumen tenant-scoped, diario/mayor, conciliación bancaria, alternativa PDF, restore drill y staging HTTPS. La aceptación pública pasó 2/2 recorridos y la prueba moderada externa fue validada el 14/09/2026 tras resolver sus dos observaciones. SMTP no bloquea y queda aplazado por decisión de producto. Detalle en `docs/05_plan_producto_usable.md`.                                                                                                                                                                                       |

### Regla operativa de commits

**U6-08 cerrado para U6A/U6B (17/09/2026):** aceptación local con E2E/WCAG,
SMTP capturado, PDFs renderizados, seed idempotente, imágenes y restore drill de 43
migraciones; aceptación HTTPS 3/3 sobre `bb337bb` con los tres correos y PDF en el
buzón controlado, y prueba moderada administrativa sin incidencias. El acta distingue
la evidencia observada de los datos de restauración remota aún sin archivar. Véase
`docs/12_aceptacion_u6.md`.
Una repetición del 18/09 falló en el test de Cartera por navegación de filtros aún
pendiente; tras sincronizar el E2E, la suite volvió a pasar 3/3 contra staging desde
el entorno local. El workflow GitHub
[`#35330297690`](https://github.com/CoralDataLab/pastagansa/actions/runs/35330297690)
pasó 3/3 sobre `49b52d0`; el operador confirmó la recepción de los tres correos.

**AEAT pruebas (18/09/2026):** un alta F1 de la posición 3 fue aceptada sin
errores por el servicio de pruebas, con CSV visible y cadena local verificada.
La posición 1 conserva el rechazo censal en su alta original; la captura posterior
muestra su anulación aceptada en la posición 5. El alta original de la posición 2
conserva su aviso horario y su subsanación figura aceptada en la posición 4. La
cadena local aparece verificada con cinco registros. Evidencia y
límites en `docs/14_aceptacion_aeat_pruebas.md`.
Una rectificativa R4 por diferencias fue aceptada en AEAT pruebas en la posición
6, con cadena local verificada y libro de IVA negativo. Su XML validó con el XSD
local y las huellas propia y anterior coincidieron. La captura posterior mostró
la original `F2026-0003` **Rectificada** y con 0,00 € pendientes. La clasificación
fiscal del motivo de una operación real sigue sin validarse con esta prueba.

**R1 (aceptación técnica en AEAT pruebas, 18/09/2026):** la factura de venta guarda la fecha de
operación antes de emitirse; si coincide con la emisión, se conserva esa fecha
como valor por defecto. Una R1 copia la fecha de la original y su XML congelado
incluye `FechaOperacion`, referencia de la factura rectificada y importes con
signo. La fecha distinta aparece también en el XML F1 original, el PDF y el
libro de IVA. No se rellena retroactivamente la fecha de originales históricos y se
bloquea la creación de R1 si falta. Migración, XSD, pruebas unitarias e
integrales locales verificados. El operador confirmó `565883e` desplegado en
staging; el PDF F1 `F2026-0004` y su XML de alta de la posición 7 muestran
`FechaOperacion=15-09-2026`. El XML validó contra el XSD local y su huella
enlaza con la posición 6. El operador comunicó aceptación AEAT con CSV para
esa F1 y para la R1 `R2026-0002` (posición 8), además del estado
**Rectificada** y 0,00 € pendientes en la original. El XML R1 pasó XSD,
huella y enlace con la posición 7; los CSV y SOAP no se cotejaron
directamente. Véase `docs/14_aceptacion_aeat_pruebas.md`.
El PDF reserva espacio adicional al QR cuando muestra una fecha de operación
distinta: la maquetación se inspeccionó y una prueba comprueba que la etiqueta
del QR quede por debajo del vencimiento. El operador confirmó la corrección en
staging y el PDF redescargado se inspeccionó sin solapamiento; véase el acta.

**Anulación de factura emitida por error (aceptación manual en staging, 18/09/2026):**
API y web incorporan un flujo para operación inexistente sin cobros ni
rectificativas. Reutiliza la anulación SIF si ya existe y añade en una sola
transacción el estado `CANCELLED`, un apunte negativo vinculado en Tax Ledger y
un asiento de reversión. La migración y las pruebas de integración pasaron en
PostgreSQL local aislado. La captura posterior al despliegue mostró la factura
anulada, la reversión contable #4, el apunte de IVA de −200,00 € / −42,00 € y
la cadena SIF de cinco registros sin una segunda anulación. El XML de la
posición 5 se validó localmente y su SHA-256 consta en el acta, sin copiarlo al
repositorio. El operador comunicó como SHA del segundo despliegue
`04160cdc2f82ffdfe7a2dd4c1ed4980f5d090ce5`; el saldo pendiente no se
mostró en la captura, pero el operador confirmó después que la factura anulada
indicaba `0,00 €`. Una consulta SSH posterior confirmó ese HEAD. La respuesta
SOAP no se cotejó directamente. El operador confirmó que el ensayo de
restauración posterior a la migración terminó con `Restore drill passed`, sin
archivar su log ni recuentos. La revisión fiscal y la aprobación para producción
siguen pendientes.

El operador comunicó `954085ffe78dfccee4bc2f80f2aaa26b163495b8` como SHA
desplegado en la prueba AEAT inicial; incluye la recuperación AEAT probada,
pero precede al flujo de anulación económica de `581e4b0`.

Antes de cada commit que cambie producto, infraestructura, datos o documentación de alcance, actualizar esta tabla y/o su detalle cuando el estado real cambie. El commit debe incluir esa actualización y la validación ejecutada debe quedar indicada en su mensaje de entrega.

> Los tiempos se expresan como referencia de planificación y dependen del tamaño, experiencia y dedicación del equipo. La prioridad del plan es el orden de dependencias y los criterios de calidad, no prometer una fecha fija.

---

# 1. Objetivos del programa

1. Construir un ERP multiempresa.
2. Conseguir flujo completo de venta y compra.
3. Automatizar contabilidad.
4. Implementar motor fiscal español.
5. Generar libros y modelos principales.
6. Integrar tesorería.
7. Adaptar el sistema a SIF/VERI\*FACTU.
8. Tener auditoría y seguridad suficientes para producción.
9. Pilotar con empresas reales.
10. Preparar extensiones CRM, proyectos, inventario y e-factura.

---

# 2. Principio de entrega

No desarrollar “pantallas aisladas”.

Cada vertical se entrega de extremo a extremo:

```text
UI
→ API
→ dominio
→ persistencia
→ auditoría
→ tests
```

Y si tiene impacto fiscal:

```text
documento
→ Tax Ledger
→ asiento
→ libro
→ modelo
```

---

# 3. Equipo de referencia

Equipo recomendable para P0:

## Producto

- 1 Product Manager / Product Owner.

## Ingeniería

- 1 Tech Lead / arquitecto;
- 2 backend senior;
- 1 backend/full-stack;
- 2 frontend/full-stack;
- 1 QA automation.

## Especialistas

- 0,5–1 DevOps/SRE;
- 0,5 UX/UI;
- asesor contable/fiscal recurrente;
- apoyo legal/protección de datos;
- especialista seguridad en hitos.

Un equipo más pequeño puede ejecutar el plan, pero deberá reducir alcance o aumentar el número de sprints.

---

# 4. Gobernanza

## 4.1 Comité semanal de producto

Revisa:

- alcance;
- bloqueos;
- decisiones;
- riesgos;
- métricas.

## 4.2 Revisión fiscal quincenal

Participantes:

- product;
- backend;
- contable/fiscal.

Revisar:

- casos nuevos;
- cambios normativos;
- fixtures;
- modelos;
- SIF.

## 4.3 Arquitectura

Toda decisión estructural relevante crea ADR.

---

# 5. Herramientas de proyecto

Recomendación:

- GitHub/GitLab;
- CI/CD;
- issue tracker;
- documentación versionada;
- ADRs en repo;
- OpenAPI;
- Sentry;
- OpenTelemetry;
- dashboard de métricas;
- feature flags.

---

# 6. Convención de backlog

Jerarquía:

```text
Initiative
→ Epic
→ Story
→ Task
```

Ejemplo:

```text
INIT: Fiscalidad España
  EPIC: IVA
    STORY: Venta nacional 21 %
      TASK: tax rule
      TASK: ledger
      TASK: accounting fixture
      TASK: book mapping
      TASK: 303 mapping
```

---

# 7. Definition of Ready

Una story entra en sprint si tiene:

- objetivo;
- actor;
- reglas;
- casos borde;
- diseño UX cuando proceda;
- impacto fiscal;
- datos;
- permisos;
- criterio de aceptación;
- dependencias.

---

# 8. Definition of Done

Una story está terminada si:

- código revisado;
- tests;
- permisos;
- auditoría;
- migración;
- observabilidad;
- documentación;
- API documentada;
- accesibilidad básica;
- error handling;
- aceptación producto;
- aceptación fiscal si aplica.

---

# 9. Estrategia general por fases

Las fases siguientes conservan el mapa de capacidades y sus dependencias, pero no
dictan por sí solas el orden inmediato de entrega. Desde septiembre de 2026 se aplica
un overlay de producto: **Hito U — Producto usable**. Hasta superar su gate se pausa la
expansión fiscal avanzada que no sea necesaria para los recorridos ya soportados.

Orden activo de ejecución:

```text
U0  Arranque reproducible y datos demo
U1  Web foundation, autenticación y contexto de empresa
U2  Venta usable de extremo a extremo
U3  Compra usable de extremo a extremo
U4  Visibilidad financiera y operación en staging
```

Después se retoma el plan de capacidades:

```text
Fase 0  Descubrimiento y arquitectura
Fase 1  Plataforma base
Fase 2  Maestro + ventas/compras
Fase 3  Contabilidad
Fase 4  Motor fiscal
Fase 5  Tesorería
Fase 6  SIF/VERI*FACTU
Fase 7  Reporting + declaraciones
Fase 8  Hardening y piloto
Fase 9  GA
Fase 10 P1/P2
```

Varias líneas pueden solaparse, pero las dependencias del dominio deben respetarse.

El alcance, criterios de aceptación y decisiones de aplazamiento del Hito U se
mantienen en `docs/05_plan_producto_usable.md`.

---

# 10. Fase 0 — Descubrimiento y arquitectura

**Duración de referencia:** 2 sprints.

## Objetivos

- cerrar alcance P0;
- validar modelo fiscal;
- definir arquitectura;
- preparar repositorios;
- crear matriz normativa.

## Entregables

- PRD funcional;
- especificación técnica;
- ADRs 001–010;
- modelo conceptual;
- arquitectura;
- catálogo de permisos;
- catálogo de eventos;
- casos fiscales;
- backlog inicial;
- matriz de riesgos.

## Tareas

### Producto

- personas;
- journeys;
- prioridades;
- flujos.

### Fiscal

Definir fixtures para:

- venta 21/10/4/0;
- exenta;
- no sujeta;
- compra;
- profesional 15/7;
- alquiler;
- intracomunitaria;
- inversión sujeto pasivo;
- rectificativa.

### Técnico

- repo;
- monorepo/multirepo;
- CI;
- lint;
- test;
- Docker;
- staging skeleton.

## Gate de salida

No comenzar fiscalidad sin casos de aceptación aprobados por especialista.

---

# 11. Fase 1 — Plataforma base

**Duración:** 2–3 sprints.

## Epics

### Identity

- registro;
- login;
- recuperación;
- MFA;
- sesiones.

### Organizations

- organización;
- empresa;
- configuración.

### Permissions

- roles;
- scopes;
- middleware.

### Audit

- audit log.

### Files

- upload;
- object storage;
- antivirus.

### Platform

- logging;
- tracing;
- metrics;
- errors.

## Criterios

- un usuario de empresa A no accede a B;
- tests de aislamiento;
- auditoría;
- backups iniciales.

---

# 12. Fase 2 — Maestros

**Duración:** 1–2 sprints.

**Estado real:** Completada. El gate de datos listos para documentos comerciales está cubierto y validado en PostgreSQL. La experiencia web y los filtros adicionales se gestionan como trabajo transversal de producto, sin reabrir el contrato de datos de esta fase.

## Contacts

- CRUD;
- NIF;
- direcciones;
- cliente/proveedor;
- condiciones.

## Catalog

- producto;
- servicio;
- precio;
- impuesto sugerido;
- cuenta.

## Import

- CSV contactos;
- CSV productos.

## UX

- búsqueda;
- tablas;
- filtros;
- selección empresa.

## Gate

Datos listos para crear documentos comerciales.

---

# 13. Fase 3 — Ventas

**Duración:** 3 sprints.

**Estado real:** En curso. Implementados presupuestos hasta PDF, con cambios de estado atómicos condicionados al estado esperado por el cliente. Implementados borradores de factura con líneas, totales decimales, snapshots de emisor/cliente/dirección/email, paginación opaca y CRUD restringido al estado borrador. Implementadas también series documentales configurables por empresa. La emisión idempotente, numeración atómica e inmutabilidad de cabecera y líneas están validadas en PostgreSQL, incluida la asignación correcta de 100 números concurrentes. Implementados PDF oficial multipágina y descarga solo tras emisión, más un outbox transaccional de email con idempotencia concurrente, aislamiento RLS, entrega SMTP con PDF adjunto, leases recuperables, reintentos exponenciales y estado de seguimiento. Implementadas rectificativas totales, parciales y por diferencias como documentos enlazados a la factura original, con motivo, impacto económico, serie `CREDIT_NOTE`, bloqueo concurrente y límite acumulado para disminuciones; la rectificativa total congela una copia de las líneas originales y marca la original como rectificada al emitirse. Implementados vencimientos configurables cuya suma debe coincidir con el total, vencimiento único automático al emitir sin calendario explícito y cobros manuales idempotentes, append-only y asignados por antigüedad; saldo y estados de factura/cuota se actualizan atómicamente bajo bloqueo de factura, impidiendo carreras y sobrecobros. Las migraciones y los flujos integrales se validaron en PostgreSQL local, y el PDF rectificativo fue renderizado e inspeccionado visualmente. Pendientes confirmación en CI, SMTP de staging, recurrentes, devoluciones, cobros multidocumento y pagos salientes.

## Sprint A

- presupuesto;
- líneas;
- totales;
- PDF;
- estados.

## Sprint B

- factura borrador;
- series;
- numeración;
- emisión;
- PDF;
- email.

## Sprint C

- rectificativas;
- recurrentes;
- vencimientos;
- pagos manuales.

## Casos de concurrencia

Probar:

- 100 emisiones simultáneas misma serie;
- retry;
- crash entre numeración y commit.

## Gate

Nunca debe duplicarse serie+número.

---

# 14. Fase 4 — Compras y gastos

**Duración:** 2 sprints.

**Estado real:** Completada para su alcance obligatorio. Implementadas alta manual, validación de proveedor, protección frente a números duplicados, snapshots fiscales con porcentaje deducible, aprobación idempotente, numeración interna correlativa, inmutabilidad y publicación transaccional al Tax Ledger de facturas recibidas y al diario contable. Los vencimientos son configurables en borrador, deben sumar el total, se congelan al aprobar, exponen mora a una fecha explícita y reciben un vencimiento único automático cuando no hay calendario. Los pagos salientes manuales append-only e idempotentes se asignan por antigüedad mediante repartos inmutables, con saldo parcial/final, protección concurrente frente al sobrepago y asiento automático de proveedor contra banco. Los adjuntos de borrador se almacenan en PostgreSQL dentro de la transacción, con máximo de 20 ficheros de 10 MiB, allowlist PDF/PNG/JPEG validada por firma, deduplicación SHA-256, descarga autenticada, RLS y congelación al aprobar. El circuito multinivel permite configurar por empresa tramos de importe con uno a cinco aprobadores distintos; el primer visto bueno congela datos, vencimientos, adjuntos y secuencia solicitada, un rechazo razonado devuelve el documento a borrador, y solo el último aprobador dispara numeración, Tax Ledger y asiento. El OCR asíncrono local reconoce PNG/JPEG en español, conserva motor/versión/texto/evidencia/confianza, usa leases y tres intentos, exige revisión humana auditable e inmutable y bloquea la aprobación mientras haya extracciones pendientes. PDF OCR, object storage y antivirus permanecen en el hardening transversal de plataforma y no bloquean este gate funcional.

## Funciones

- alta manual;
- upload;
- documento proveedor;
- aprobación;
- vencimientos;
- adjuntos.

## OCR inicial

- proveedor;
- fecha;
- número;
- totales;
- confianza;
- revisión humana.

## Gate

Documento aprobado preparado para Tax/Accounting.

---

# 15. Fase 5 — Motor contable

**Duración:** 3–4 sprints.

**Estado real:** Completada para su alcance obligatorio. Implementados plan contable inicial inspirado en PGC, cuentas configurables, reglas por empresa para venta, compra, cobro y pago, ejercicios y periodos mensuales, diario equilibrado, contabilización automática de facturas de venta, rectificativas, compras con IVA parcialmente deducible, cobros de cliente y pagos a proveedor contra bancos, asiento manual idempotente, numeración anual serializada, reversión, bloqueo de periodos, balance de sumas y saldos, diario y mayor exportables en JSON/CSV, conciliación bancaria uno-a-uno, auditoría, permisos, RLS e invariantes de inmutabilidad/equilibrio en PostgreSQL. Las reglas configurables validan combinaciones evento/rol y cuentas activas de la clase y empresa correctas, se aplican solo a asientos futuros y preservan el histórico posted. Los informes aplican rangos acotados, orden determinista, totales y protección contra inyección de fórmulas. El gate de asiento inmutable, reversión y periodo protegido está cubierto por pruebas integrales. PyG, balance de situación, cierre básico y centros permanecen en el Sprint D opcional y no bloquean el cierre de fase.

## Sprint A — Foundation

- accounts;
- fiscal years;
- journals;
- entries;
- lines;
- balances.

## Sprint B — Rules

- accounting rules;
- venta;
- compra;
- cobro;
- pago.

## Sprint C — Controls

- posting;
- reversal;
- period lock;
- reconcile;
- journal/mayor.

## Sprint D opcional

- balance;
- PyG;
- cierre básico;
- centros.

## Golden cases

Todos los casos deben comprobar debe=haber.

## Gate

- asientos posted inmutables;
- reversión funcional;
- periodo cerrado protegido.

---

# 16. Fase 6 — Motor fiscal foundation

**Duración:** 4 sprints.

Esta fase es núcleo del producto.

## Sprint A — Tax Rules

- tax profile;
- tax rules;
- vigencias;
- IVA sujeto/exento/no sujeto;
- 21/10/4/0.

## Sprint B — Tax Ledger

- ledger;
- amounts;
- emitted/received;
- deduction date;
- deducibilidad.

## Sprint C — Withholding

- practised;
- suffered;
- professional;
- rental;
- claves.

## Sprint D — Special cases

- intracomunitaria;
- inversión sujeto pasivo;
- exportación;
- rectificativa;
- bienes inversión foundation.

## Gate

Cada factura de fixture genera ledger esperado.

---

# 17. Fase 7 — Libros IVA/IRPF

**Duración:** 2–3 sprints.

## IVA

- expedidas;
- recibidas;
- bienes inversión;
- determinadas intracomunitarias.

## IRPF

- ingresos;
- gastos;
- bienes;
- provisiones/suplidos.

## Export

- CSV;
- XLSX;
- formato normalizado compatible con especificación anual.

## Validation

Crear validador interno basado en campos requeridos.

## Gate

Fixtures aceptados por especialista y exportables.

---

# 18. Fase 8 — Modelos fiscales

**Duración:** 4 sprints.

## Sprint A — Framework

- form version;
- box definition;
- expressions;
- snapshot;
- explainability.

## Sprint B — IVA

- 303;
- validaciones;
- reconciliación.

## Sprint C — Retenciones

- 111;
- 115;
- 180;
- 190.

## Sprint D — Autónomos y terceros

- 130;
- 347;
- 349.

## Principio

No crear un controller distinto con reglas hardcodeadas para cada año.

## Gate

Cada casilla puede explicar qué registros la componen.

---

# 19. Fase 9 — Tesorería

**Duración:** 2–3 sprints.

**Estado real:** En curso. Implementadas cuentas bancarias vinculadas a cuentas contables conciliables, importación atómica de movimientos normalizados con deduplicación, listado paginado, sugerencias de líneas posted no conciliadas por importe exacto, dirección, ventana de fecha y referencia, y confirmación explícita uno-a-uno. Las conciliaciones son append-only y están protegidas por locks, constraints, triggers, permisos, auditoría y RLS. Pendientes adaptadores CSV/Norma 43, saldo bancario, conciliación parcial/combinada, reglas avanzadas y Open Banking.

## Sprint A

- cuentas;
- import CSV;
- Norma 43;
- transacciones.

## Sprint B

- pagos/cobros;
- matching;
- conciliación.

## Sprint C

- proveedor Open Banking inicial;
- sync;
- errores;
- reconexión.

## Gate

No crear IVA desde extracto.

---

# 20. Fase 10 — SIF/VERI\*FACTU

**Duración:** 3–4 sprints más validación.

**Estado real:** En curso. Implementados los primeros slices de foundation: cada emisión
en modo SIF crea en su misma transacción un registro de alta inmutable y auditable, con cadena única
por empresa y snapshot canónico del material de huella. Las nuevas emisiones con `DISABLED`
no crean registro SIF ni QR fiscal; los registros anteriores permanecen intactos. El componente de hash está
versionado como `AEAT-HASH-0.1.2`, utiliza SHA-256, UTF-8 y hexadecimal en mayúsculas y
reproduce los dos vectores oficiales de alta. PostgreSQL valida pertenencia a una
factura emitida, continuidad, hash anterior, orden temporal, append-only y RLS. La
exportación de nuevos registros F1 estándar, rectificativas R1/R4 por diferencias y anulaciones usa una copia XML congelada
en el `payload` al generar el registro; los históricos usan lectura compatible. La
API expone un inventario read-only de transición por empresa, modo, entorno, tipo de
registro e identificador de software, sin decidir automáticamente cómo iniciar una
cadena reglamentaria a partir de registros de prueba. La
trazabilidad web muestra posición, algoritmo, versión y huella abreviada. Cada factura
conserva una clasificación SIF inmutable: F1 para facturas completas y R1–R5 para
rectificativas. La web permite crear un abono total eligiendo R1–R4 según el motivo
jurídico, muestra esa clasificación y permite emitirlo con una serie rectificativa;
R5 se rechaza mientras no existan facturas simplificadas F2. La anulación se genera
como un segundo registro append-only, con la huella AEAT específica, vinculado al alta
anulada y encadenado al último registro de la empresa; una repetición devuelve el mismo
registro y la verificación rechaza enlaces o huellas alteradas. La acción SIF aislada
no modifica la factura, su asiento ni el libro de IVA. Si la operación existió,
la corrección económica se realiza mediante rectificativa; para una operación
inexistente existe un flujo específico de anulación de factura.
El QR fiscal no VERI*FACTU aparece en la factura, y cada registro captura el perfil del
productor; existe además un borrador descargable de declaración responsable. Ya se puede
descargar un lote XML AEAT, unsigned y sin remisión, por registro de alta F1 estándar,
R1/R4 por diferencias o anulación: conserva la cabecera, encadenamiento, perfil de software
y huella históricos. R1 usa la fecha de operación capturada antes de emitir la original;
se bloquea para originales históricos sin ese dato, sin inferirlo. El exportador rechaza
R2–R3, R5 y desgloses exentos, no sujetos o con
recargo, inversión del sujeto pasivo y tipos IVA fuera de `0`, `4`, `10`, `21` hasta
modelar sus claves y reglas AEAT, en vez de inventar campos fiscales. El contraste
del 17/09/2026 confirmó los XSD locales, el elemento de entrada WSDL y los tres casos
sintéticos; el 18/09/2026 una alta F1 ordinaria obtuvo respuesta **Aceptado**
en el servicio AEAT de pruebas (véase `docs/14_aceptacion_aeat_pruebas.md`). También limita
desde configuración el perfil de software a los máximos del XSD, incluido el identificador
de dos caracteres. La remisión de pruebas usa certificado cliente y outbox; un
rechazo confirmado ya no bloquea los siguientes registros de la cadena.
El código de recuperación añade `SinRegistroPrevio=S` al anular un alta rechazada
en una respuesta definitiva de línea de AEAT; bloquea estados de transporte ambiguos.
Para una alta aceptada con aviso de `FechaHoraHusoGenRegistro`, permite generar una
nueva alta `Subsanacion=S` con hora actual, enlazada a la original y sin alterar
factura ni XML anteriores. Las capturas de staging muestran la subsanación y la
anulación aceptadas, con cinco registros en la cadena local verificada. El XML
exportado de la anulación se inspeccionó y validó localmente; véase el acta.
Una R4 por diferencias se aceptó también en pruebas en la posición 6, con XML
congelado validado localmente y cadena verificada de seis registros.
La recuperación de remisiones inciertas de AEAT pruebas reenvía el XML congelado
tras timeout o lease caducado, con espera exponencial limitada y protección de
lease frente a respuestas tardías. Una respuesta de duplicado de alta solo se
reconcilia si la consulta oficial confirma identidad, huella SIF, estado e
`IdPeticion`; la respuesta de consulta queda almacenada, sin atribuirle el CSV
original. Los duplicados no verificables y las anulaciones duplicadas siguen
inciertos y bloquean la cadena. Validación local: pruebas de timeout, reenvío
idéntico, duplicado coincidente/no coincidente, parser SOAP, build y migración.
El workflow CI `#35341071096` pasó completo. Con el checkout de staging en
`56de778`, el recuento agregado comunicado por el operador fue 6 aceptados,
1 aceptado con errores y 1 rechazado, sin `UNKNOWN` ni `RETRY`; por tanto, aún
no existe evidencia de recuperación real con la AEAT. Véase el acta
`docs/14_aceptacion_aeat_pruebas.md`.
La configuración muestra ahora un resumen de remisiones AEAT Pruebas por empresa,
con recuentos de todos los estados y los veinte envíos inciertos, fallidos o en
reintento más recientes enlazados a su factura. La consulta exige
`sif_record.read`, aplica el ámbito de empresa/organización y no devuelve XML
ni secretos. Esta visibilidad permite detectar futuros casos sin SQL; el
recuento de staging anterior sigue siendo una observación manual, no una
aceptación de esta nueva pantalla.
Después del despliegue, la captura del operador mostró el resumen esperado
(6 aceptados, 1 con errores, 1 rechazado y cero pendientes); SSH confirmó el
checkout `a91f8ba` y la web/API fueron alcanzables. Los healthchecks Docker
no se cotejaron directamente. Evidencia y límites en el acta AEAT.
Como primer paso de subsanación general, la misma vista lista hasta veinte
resultados con errores o rechazo, con código, descripción, factura,
posición SIF y estados de subsanaciones o anulaciones posteriores. Señala como
posible acción el único caso ya soportado, el aviso de fecha/hora aún sin
seguimiento; los rechazos globales sin respuesta de línea y los demás casos
requieren revisión individual. Es una clasificación
de solo lectura: no reenvía, no altera la cadena y no declara resuelta una
incidencia por existir un registro posterior. La [guía AEAT sobre integridad e
inalterabilidad](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/caracteristicas-requisitos-sif-integridad-inalterabilidad.html)
exige conservar el registro erróneo y generar uno nuevo para subsanarlo.
La captura posterior al despliegue mostró los dos resultados históricos con
sus seguimientos aceptados (posiciones 2→4 y 1→5), mantuvo los recuentos
6/1/1 y cero pendientes. SSH confirmó el checkout `6fc6171`; el acta precisa
los límites de esta comprobación.
Pendientes subsanación general de errores y rechazos, firma/eventos NO
VERI*FACTU, soporte de toda la casuística fiscal y revisión de conformidad para
producción.

## Sprint A — Modelo

- SIF record;
- alta;
- anulación;
- cadena;
- versioning.

## Sprint B — QR/huella

- hash según especificación;
- QR;
- factura visual;
- fixtures.

## Sprint C — VERI\*FACTU

- sender;
- batching;
- response;
- retry;
- queue;
- monitoring.

## Sprint D — Compliance

- declaración responsable;
- UI de estado;
- errores;
- runbook;
- auditoría.

## Gate

Validación contra documentación técnica y entorno de pruebas disponible.

---

# 21. Fase 11 — Reporting y dashboards

**Duración:** 2 sprints.

## Reporting

- ventas;
- compras;
- tesorería;
- diario;
- mayor;
- balance;
- PyG;
- IVA;
- retenciones.

## Dashboard

- KPIs;
- alertas;
- drilldown.

No ejecutar agregaciones costosas sin optimización.

---

# 22. Fase 12 — API y webhooks

**Duración:** 1–2 sprints.

## API

- OAuth/API keys;
- OpenAPI;
- contacts;
- products;
- invoices;
- payments.

## Webhooks

- firma;
- retries;
- logs;
- portal developer.

## Gate

Security review.

---

# 23. Fase 13 — Hardening

**Duración:** 2–3 sprints.

## Seguridad

- pentest;
- tenant review;
- authorization tests;
- secret review.

## Performance

- carga;
- concurrency;
- DB indexes;
- reporting.

## Reliability

- restore test;
- failover;
- queue recovery;
- AEAT outage simulation.

## UX

- accessibility;
- keyboard;
- error messages.

---

# 24. Fase 14 — Migración piloto

**Duración:** 2–3 sprints.

Seleccionar cohortes:

1. autónomo profesional;
2. pyme servicios;
3. pyme con compras/ventas;
4. asesoría con varias empresas.

## Migrar

- contactos;
- productos;
- facturas abiertas;
- saldos;
- plan;
- asientos de apertura;
- bancos.

No intentar migrar todo histórico si no aporta valor; definir estrategia por cliente.

---

# 25. Pilot checklist

Por empresa:

- NIF;
- perfil fiscal;
- series;
- saldo de apertura;
- impuestos;
- banco;
- usuarios;
- permisos;
- documentos;
- libro;
- conciliación;
- modelo paralelo.

Ejecutar al menos un cierre paralelo contra el sistema anterior/asesoría.

---

# 26. Parallel run

Durante piloto fiscal:

```text
Nuevo ERP
vs
sistema/asesoría existente
```

Comparar:

- ventas;
- bases;
- IVA;
- retenciones;
- asientos;
- balances;
- modelos.

Toda diferencia requiere clasificación:

- bug;
- dato migrado;
- criterio;
- redondeo;
- configuración.

---

# 27. GA — criterios de lanzamiento

No lanzar GA si falta alguno de los críticos:

## Producto

- flujo venta;
- compra;
- banco;
- contabilidad;
- fiscal.

## Fiscal

- golden suite;
- revisión externa;
- SIF válido;
- libros;
- modelos.

## Seguridad

- pentest sin críticos;
- MFA;
- audit;
- backups.

## Operaciones

- monitoring;
- alertas;
- runbooks;
- soporte;
- incident response.

---

# 28. Backlog P0 por prioridad

Mientras el Hito U esté abierto, este backlog se interpreta con una prioridad previa:
ninguna ampliación de dominio desplaza un slice necesario para que los recorridos de
venta y compra existentes puedan completarse desde la web y verificarse en staging.

## P0.0 — Crítico

- shell web, autenticación y contexto de empresa;
- cliente → factura emitida → PDF desde navegador;
- compra → adjunto/OCR → revisión → aprobación desde navegador;
- seed demo, E2E de navegador y staging reproducible;
- tenant isolation;
- auth;
- invoice issuance;
- numbering;
- Tax Ledger;
- accounting;
- audit;
- SIF.

## P0.1

- purchases;
- banks;
- 303;
- 111;
- 115;
- 130;
- books.

## P0.2

- 180;
- 190;
- 347;
- 349;
- recurring;
- OCR.

## P0.3

- polish;
- analytics;
- API.

---

# 29. Matriz de dependencias

```text
Identity
  ↓
Company
  ↓
Contacts/Catalog
  ↓
Sales/Purchases
  ├───────────┐
  ↓           ↓
Tax Rules   Accounting Foundation
  ↓           ↓
Tax Ledger  Accounting Rules
  └─────┬─────┘
        ↓
     Books
        ↓
     Forms
```

SIF depende de factura estable, pero puede desarrollarse en paralelo al motor de modelos.

---

# 30. Casos fiscales mínimos de aceptación

## IVA nacional

1. Venta 21 %.
2. Venta 10 %.
3. Venta 4 %.
4. Venta 0 %.
5. Exenta.
6. No sujeta.
7. Compra 21 %.
8. IVA 50 % deducible.
9. Rectificativa.

## Intracomunitario

10. Adquisición de bienes.
11. Servicio recibido.
12. Entrega.
13. Servicio prestado.

## Otros

14. Inversión sujeto pasivo.
15. Exportación.
16. Importación base.

## Retenciones

17. Profesional 15 %.
18. Profesional 7 % cuando aplique.
19. Alquiler.
20. Retención soportada.

Cada caso incluye:

```text
document
tax ledger
journal
book
form
```

---

# 31. Caso de prueba detallado — profesional

Entrada:

```text
Proveedor profesional
Base: 1.000
IVA: 21 %
Retención: 15 %
```

Esperado:

```text
IVA: 210
Retención: 150
Pago: 1.060
```

Asiento:

```text
623  1.000 D
472    210 D
410          1.060 H
4751           150 H
```

Fiscal:

- libro recibidas;
- cuota soportada/deducible según configuración;
- 303;
- 111;
- 190.

---

# 32. Caso — autónomo emisor con retención

Entrada:

```text
Base: 1.000
IVA: 210
Retención soportada: 150
Cobro: 1.060
```

Esperado:

- ingreso IRPF: 1.000;
- IVA devengado: 210;
- retención soportada: 150;
- libro ingresos;
- 303;
- datos para 130;
- saldo cliente/cobro.

---

# 33. Caso — adquisición intracomunitaria

Base:

```text
1.000
```

Efecto:

- proveedor 1.000;
- IVA devengado 210;
- IVA soportado 210;
- deducible según derecho;
- 303;
- 349 si corresponde;
- libro.

---

# 34. Casos de fallo

Probar explícitamente:

- NIF inválido;
- serie cerrada;
- periodo bloqueado;
- regla fiscal sin vigencia;
- factura con total inconsistente;
- asiento no equilibrado;
- SIF chain corrupta;
- webhook duplicado;
- bank transaction duplicada;
- import duplicate;
- cross-tenant IDOR.

---

# 35. Estrategia de automatización QA

Pirámide:

```text
muchos unit
muchos integration
golden fiscal
menos E2E
security/performance
```

Pipeline bloquea merge si falla fixture fiscal crítico.

---

# 36. Gestión del cambio normativo

Proceso:

```text
Nueva norma/cambio AEAT
→ issue compliance
→ análisis
→ fecha efectiva
→ nueva rule version
→ fixtures
→ migration si procede
→ release notes
→ despliegue
```

Nunca alterar registros históricos para adoptar norma futura.

---

# 37. Calendario de revisión normativa

## Mensual

- AEAT;
- BOE;
- incidencias técnicas.

## Antes de cada campaña/año

- retenciones;
- 303;
- modelos;
- libros;
- SII;
- algoritmos.

## Antes de release fiscal

- revisión externa.

---

# 38. Estrategia de ramas/releases

Recomendación trunk-based.

Releases frecuentes.

Versionado:

```text
application version
tax rules package version
SIF adapter version
```

Permitir saber exactamente con qué lógica se creó cada registro.

---

# 39. Feature flags

Usos:

- beta;
- nuevos modelos;
- piloto SII;
- banco;
- e-invoice.

Activar por empresa.

---

# 40. Migraciones de datos

Fases:

1. extract;
2. normalize;
3. map;
4. validate;
5. dry-run;
6. reconcile;
7. production import;
8. sign-off.

Crear reporte:

```text
source count
imported count
rejected count
warnings
financial totals
```

---

# 41. Integridad de migración contable

Comparar antes/después:

- saldo clientes;
- proveedores;
- bancos;
- IVA;
- retenciones;
- balance;
- PyG si se migra ejercicio.

No basta con comparar número de filas.

---

# 42. Observabilidad desde primera fase

Dashboards:

- app errors;
- DB;
- queue;
- auth;
- invoices;
- SIF;
- bank;
- fiscal calculations.

Alertas de negocio:

- secuencia fallida;
- emisión bloqueada;
- diferencia contable;
- fallo SIF.

---

# 43. Soporte operativo

Niveles:

## L1

- usuario;
- configuración;
- imports.

## L2

- contabilidad/fiscal;
- integraciones.

## L3

- ingeniería;
- defectos;
- datos.

Crear herramienta interna de diagnóstico sin permitir edición destructiva.

---

# 44. Runbooks esenciales

1. factura emitida con error detectado;
2. rectificación;
3. fallo de AEAT;
4. SIF queue bloqueada;
5. importación fallida;
6. conciliación incorrecta;
7. reapertura;
8. restore;
9. acceso comprometido;
10. proveedor bancario caído.

---

# 45. Seguridad — hitos

## Pre-pilot

- threat model;
- code scanning;
- tenant tests.

## Pre-GA

- pentest externo;
- remediation;
- incident drill.

## Post-GA

- vulnerabilidades;
- rotación;
- revisiones periódicas.

---

# 46. Modelo de amenazas prioritario

Activos:

- datos fiscales;
- facturas;
- asientos;
- certificados;
- bancos;
- usuarios.

Amenazas:

- IDOR;
- account takeover;
- ransomware;
- secrets leak;
- malicious upload;
- fraudulent invoice edits;
- internal misuse.

Controles explícitos para cada uno.

---

# 47. Plan de performance

## Fase piloto

Dataset sintético:

- 100 empresas;
- 100k documentos.

## Pre-GA

- 10k empresas simuladas;
- tenant grande;
- concurrencia emisión.

## Post-GA

basado en telemetría.

---

# 48. Índices iniciales críticos

Analizar:

- invoices(company_id, issue_date);
- invoices(company_id, series, number);
- tax_ledger(company_id, tax_point_date);
- journal_entries(company_id, entry_date);
- bank_transactions(company_id, date);
- contacts(company_id, tax_id).

Revisar mediante EXPLAIN real.

---

# 49. Plan P1

Tras estabilizar P0:

## Contabilidad

- activos avanzados;
- amortizaciones;
- cierres;
- cuentas anuales.

## Fiscal

- SII;
- prorrata;
- bienes inversión;
- criterio caja;
- regímenes;
- 390;
- IS.

## Producto

- inventario;
- CRM;
- proyectos;
- portal.

## Integraciones

- e-factura;
- e-commerce;
- más bancos.

---

# 50. Plan P2

- RR. HH./nómina;
- TPV;
- fabricación;
- IGIC;
- IPSI;
- forales;
- BI;
- marketplace;
- automatización avanzada;
- mobile.

---

# 51. Riesgos del programa

| Riesgo                   | Probabilidad | Impacto | Acción                  |
| ------------------------ | ------------ | ------- | ----------------------- |
| Alcance excesivo         | Alta         | Alto    | P0 estricto             |
| Error fiscal             | Media        | Crítico | golden tests + revisión |
| Cambio normativo         | Alta         | Alto    | versionado              |
| SIF tardío               | Media        | Crítico | iniciar en paralelo     |
| Falta experto contable   | Media        | Alto    | contratación temprana   |
| Migraciones              | Alta         | Alto    | dry-runs                |
| Multi-tenancy defectuoso | Baja/media   | Crítico | tests + RLS             |
| UX contable lenta        | Media        | Alto    | usuarios piloto         |
| Vendor banking           | Media        | Medio   | adapter                 |
| OCR sobreconfiado        | Media        | Medio   | human review            |

---

# 52. Registro de decisiones

Cada ADR debe incluir:

- contexto;
- decisión;
- alternativas;
- consecuencias;
- fecha;
- owner.

No depender de conocimiento oral del equipo.

---

# 53. Documentación entregable por fase

## Producto

- stories;
- journeys;
- criteria.

## Técnico

- OpenAPI;
- schema;
- ADR;
- runbook.

## Fiscal

- regla;
- referencia;
- fixture;
- mapping.

## QA

- tests;
- evidence.

---

# 54. KPIs de delivery

- lead time;
- deploy frequency;
- escaped defects;
- fiscal defect count;
- flaky tests;
- MTTR;
- sprint predictability;
- code review latency.

---

# 55. KPIs de calidad fiscal

- diferencias 303;
- diferencias 111/190;
- diferencias 115/180;
- documentos sin clasificación;
- ledger exceptions;
- SIF rejects;
- libros con validaciones fallidas.

Objetivo: cero diferencias inexplicadas.

---

# 56. KPIs de producto post-GA

- activación;
- tiempo hasta primera factura;
- conciliación automática;
- tiempo cierre;
- retención;
- churn;
- soporte;
- NPS/CSAT;
- documentos por empresa.

---

# 57. Acceptance gate fiscal

Un release que modifica impuestos requiere:

1. referencia normativa;
2. regla versionada;
3. test;
4. comparación;
5. code review;
6. review fiscal;
7. staging;
8. release notes.

---

# 58. Acceptance gate SIF

Requiere:

- estructura;
- hash/chain;
- QR;
- alta/anulación;
- sender;
- retries;
- audit;
- declaración responsable;
- pruebas de proveedor/AEAT según medios disponibles;
- revisión de especificación vigente.

---

# 59. Go-live checklist

## Plataforma

- [ ] producción creada;
- [ ] backups;
- [ ] restore probado;
- [ ] monitoring;
- [ ] alerts.

## Seguridad

- [ ] MFA;
- [ ] secrets;
- [ ] pentest;
- [ ] roles;
- [ ] audit.

## Producto

- [ ] onboarding;
- [ ] invoices;
- [ ] purchases;
- [ ] banking.

## Contabilidad

- [x] PGC;
- [x] diario;
- [x] mayor;
- [ ] balance.

## Fiscal

- [ ] tax rules;
- [ ] books;
- [ ] 303;
- [ ] 111/115/130;
- [ ] annual information models;
- [ ] SIF.

## Operaciones

- [ ] support;
- [ ] runbooks;
- [ ] status page/process;
- [ ] incident contacts.

---

# 60. Plan de piloto recomendado

Cohorte inicial:

- 5–10 autónomos;
- 5–10 pymes de servicios;
- 2–3 asesorías;
- evitar al principio operaciones extremadamente especiales.

Duración basada en al menos:

- un ciclo completo de facturación;
- una conciliación;
- un cierre fiscal paralelo.

No usar piloto para ocultar falta de pruebas normativas.

---

# 61. Criterios para ampliar cohortes

- cero defectos críticos;
- diferencias fiscales explicadas;
- tiempos aceptables;
- soporte controlado;
- remisiones estables;
- migración repetible.

---

# 62. Estrategia de rollout

```text
internal
→ design partners
→ closed beta
→ open beta / limited GA
→ GA
```

Feature flags por empresa.

---

# 63. Plan de e-factura B2B

Trabajo preparatorio P1:

1. modelo canónico;
2. formato/adapters;
3. estados;
4. recepción;
5. interoperabilidad;
6. plataforma pública/privada;
7. cambios de Reglamento;
8. calendario efectivo.

No bloquear P0 si la obligación efectiva todavía requiere desarrollos normativos posteriores, pero mantener arquitectura preparada.

---

# 64. Gestión de deuda técnica

Presupuesto por sprint:

- 10–20 % en refactor/hardening según fase.

No aplazar:

- tenant isolation;
- idempotencia;
- auditoría;
- versionado fiscal.

Estos no son deuda aceptable.

---

# 65. Qué puede aplazarse

- microservicios;
- data warehouse;
- app nativa;
- IA avanzada;
- custom BI;
- marketplace;
- fabricación.

---

# 66. Qué no debe aplazarse

- correcta numeración;
- inmutabilidad;
- period locks;
- audit;
- tax versioning;
- golden tests;
- backup restore;
- access control;
- SIF en el calendario requerido.

---

# 67. Dependencia con expertos externos

Revisiones requeridas:

## Contable

- PGC;
- asientos;
- cierres.

## Fiscal

- IVA;
- IRPF;
- modelos;
- libros.

## Legal/privacidad

- RGPD;
- contratos;
- retención.

## Seguridad

- pentest;
- threat model.

La ingeniería implementa reglas; no debe inventarlas.

---

# 68. Matriz RACI resumida

| Entregable      | Product | Tech | Fiscal | QA  | DevOps |
| --------------- | ------- | ---- | ------ | --- | ------ |
| Journey         | A/R     | C    | C      | C   | I      |
| Tax rule        | C       | R    | A      | C   | I      |
| Accounting rule | C       | R    | A      | C   | I      |
| SIF adapter     | C       | R/A  | C      | R   | C      |
| Security        | I       | A/R  | I      | C   | R      |
| Release         | A       | R    | C      | R   | R      |
| Tax sign-off    | I       | C    | A/R    | C   | I      |

---

# 69. Estimación de referencia

Un P0 serio como el descrito no es un “MVP de pocas pantallas”.

Con un equipo experimentado de aproximadamente 7–10 personas, una planificación razonable es pensar en **varias decenas de sprints-persona y alrededor de 9–12 meses de trabajo calendario**, dependiendo de cuánto pueda paralelizarse, del grado de automatización fiscal exigido y de las integraciones.

No debe comprimirse sacrificando:

- pruebas;
- seguridad;
- integridad;
- revisión normativa.

---

# 70. Hitos ejecutivos

## Hito A — Platform Ready

Auth + tenant + audit.

**Estado: Completado.**

## Hito B — Commercial Loop

Contacto → factura → pago.

**Estado: Completado.**

## Hito C — Accounting Loop

Factura → asiento → balance.

**Estado: Completado para el alcance obligatorio de backend.**

## Hito U — Producto usable

Usuario → web → venta/compra completas → resultado financiero visible.

**Estado: Completado.**

Una persona externa completó y validó los recorridos críticos en staging sin Swagger ni
SQL. Véase `docs/05_plan_producto_usable.md`.

## Hito D — Fiscal Loop

Factura → ledger → libro → modelo.

## Hito E — Treasury Loop

Banco → pago → conciliación.

## Hito F — SIF Ready

Factura → registro → QR → remisión cuando aplique.

## Hito G — Pilot Ready

Hardening + migrations.

## Hito H — GA

Criterios de producción cumplidos.

---

# 71. Entregable final P0

El producto debe demostrar en vivo:

```text
Cliente
→ Presupuesto
→ Factura
→ SIF
→ Asiento
→ Cobro
→ Banco
→ Conciliación
→ Libro IVA
→ 303
```

Y:

```text
Proveedor profesional
→ Factura recibida
→ IVA
→ Retención
→ Asiento
→ Pago
→ Banco
→ 303
→ 111
→ 190
```

Además, para autónomo:

```text
Ingreso/gasto
→ libros IRPF
→ retenciones soportadas
→ 130
```

---

# 72. Referencias oficiales a mantener en el proyecto

- PGC: https://www.boe.es/buscar/act.php?id=BOE-A-2007-19884
- PGC-Pymes: https://www.boe.es/buscar/act.php?id=BOE-A-2007-19966
- Reglamento facturación: https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696
- SIF RD 1007/2023: https://www.boe.es/buscar/doc.php?id=BOE-A-2023-24840
- Orden HAC/1177/2024: https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138
- VERI\*FACTU AEAT: https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes.html
- Libros IVA: https://sede.agenciatributaria.gob.es/Sede/iva/libros-registro.html
- Libros electrónicos 2026: https://sede.agenciatributaria.gob.es/Sede/iva/facturacion-registro/libros-registro-iva/libro-registro-soporte-electronico.html
- Modelo 303 2026: https://sede.agenciatributaria.gob.es/Sede/todas-gestiones/impuestos-tasas/iva/modelo-303-iva-autoliquidacion_/instrucciones-2026/instrucciones-02-12-2t-4t-2026.html
- Obligaciones IRPF: https://sede.agenciatributaria.gob.es/Sede/irpf/Obligaciones.html
- Retenciones 2026: https://sede.agenciatributaria.gob.es/Sede/Retenciones.shtml
- SII: https://sede.agenciatributaria.gob.es/Sede/procedimientoini/G417.shtml
- Factura electrónica B2B RD 238/2026: https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-7295

---

# 73. Conclusión

La estrategia de implementación debe priorizar el núcleo de integridad por encima de la amplitud superficial de módulos.

Orden correcto:

```text
Plataforma
→ documentos
→ contabilidad
→ fiscalidad
→ tesorería
→ compliance
→ expansión
```

Una vez estable esa base, CRM, proyectos, inventario, RR. HH., TPV y analítica avanzada pueden incorporarse sin rehacer el núcleo.

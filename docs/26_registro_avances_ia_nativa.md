# Registro de avances — IA nativa y propuestas supervisadas

Este documento actúa como bitácora de implementación. Cada avance funcional debe quedar reflejado aquí y, cuando afecte al contrato o a la operación, también en la documentación temática correspondiente.

## 2026-10-01 — Base de comandos y propuestas supervisadas

Documentación principal: [24_base_comandos_ia_nativa.md](24_base_comandos_ia_nativa.md).

Implementado:

- Piloto API protegido por `AI_NATIVE_ENABLED`.
- Comando fijo `registrar_factura_recibida` v1 para crear compras en estado `DRAFT`.
- Ejecución transaccional con autorización desde permisos persistidos, bloqueo por empresa/comando e idempotencia.
- Tablas `command_proposals`, `command_reviews` y `command_executions` con RLS, restricciones de tenant e inmutabilidad.
- Propuestas de compra pendientes, ejecución supervisada y rechazo inmutable.
- Creación directa de compras usando el mismo ejecutor cuando el piloto está activo.
- Tests unitarios e integración PostgreSQL para permisos, tenant, idempotencia y rollback en fallo de negocio.

Garantías:

- La fuente de verdad siguen siendo las tablas de negocio existentes.
- `CommandExecution` es un recibo de ejecución, no un event store.
- El cliente no puede escoger tenant, actor ni handler arbitrario.

## 2026-10-01 — Bandeja web de revisión de propuestas

Documentación principal: [25_bandeja_revision_compras.md](25_bandeja_revision_compras.md).

Implementado:

- Ruta web `/compras/propuestas` y detalle `/compras/propuestas/:id`.
- Navegación condicionada por `GET /v1/purchase-command-proposals/capabilities` y permiso de lectura.
- Listado de propuestas por estado.
- Detalle con original inmutable, procedencia, evidencias declaradas, revisión y recibo.
- Editor de payload completo con preservación de campos fiscales no cubiertos por el formulario legado.
- Diff de cambios antes de ejecutar.
- Confirmación explícita de contraste y motivo obligatorio.
- Ejecución/rechazo vía BFF sin permitir rutas arbitrarias ni selección de actor/tenant desde el navegador.
- Tests unitarios web y pruebas Chromium de gates/flujo supervisado.

Garantías:

- Ocultar controles en UI no reemplaza la autorización API.
- Crear borrador no aprueba gasto ni contabiliza.
- Una propuesta terminal no se reabre desde la bandeja.

## 2026-10-01 — Custodia de documentos en propuestas

Documentación actualizada: [24_base_comandos_ia_nativa.md](24_base_comandos_ia_nativa.md) y [25_bandeja_revision_compras.md](25_bandeja_revision_compras.md).

Implementado:

- Tabla `purchase_proposal_documents` para custodiar PDF/PNG/JPEG antes de crear una compra.
- Límite de 10 MiB por documento y 20 documentos por propuesta.
- Detección de tipo por firma del contenido y comprobación contra `mimetype` declarado.
- Hash SHA-256 calculado sobre el binario.
- Idempotencia por propuesta + hash: subir el mismo binario devuelve el metadato existente.
- Bloqueo de nuevos documentos tras decisión final.
- Inmutabilidad SQL de documentos custodiados.
- Descarga con verificación de integridad previa.
- Evidencias de documentos custodiados incorporadas al recibo de comando al ejecutar una propuesta.
- Endpoints API:
  - `POST /v1/purchase-command-proposals/:id/documents`
  - `GET /v1/purchase-command-proposals/:id/documents/:documentId/download`
- Rutas BFF web equivalentes bajo `/api/purchase-proposals/:id/documents`.
- UI de detalle para listar documentos custodiados, subir archivos en propuestas pendientes y descargarlos.
- Tests unitarios para validación de documentos/evidencias.

Validación local:

- API: 201 unitarias correctas.
- Web: 51 unitarias correctas.
- Lint y build correctos en API y web.
- Prisma schema validado con URL ficticia.

## 2026-10-01 — Correcciones, asignación e intentos fallidos

Documentación actualizada: [24_base_comandos_ia_nativa.md](24_base_comandos_ia_nativa.md) y [25_bandeja_revision_compras.md](25_bandeja_revision_compras.md).

Implementado:

- Tabla `command_proposal_revisions` para conservar versiones corregidas sin mutar el payload original.
- Registro de rutas/campos cambiados, payload anterior, payload corregido, motivo y revisor.
- Inmutabilidad SQL y aislamiento por tenant para las revisiones.
- Inclusión de revisiones en listado/detalle API y visualización en la bandeja web.
- Tabla `command_proposal_assignments` para asignar expedientes a usuarios con membresía activa en la empresa.
- Endpoint `POST /v1/purchase-command-proposals/:id/assign` y ruta BFF equivalente.
- Endpoint `GET /v1/purchase-command-proposals/assignees` y ruta BFF equivalente para listar usuarios activos asignables.
- Historial de asignaciones con asignado, asignador, motivo y fecha, visible en la bandeja.
- Tabla `command_proposal_attempts` para registrar ejecuciones fallidas tras el rollback de negocio.
- Persistencia de payload intentado, motivo, actor, código estructurado y mensaje de error sin crear compra, revisión ni recibo.
- Visualización de intentos fallidos en el detalle de la propuesta.
- Tabla `command_proposal_events` para cadena reconstruible por propuesta, con secuencia, hash de payload, hash propio y hash anterior.
- Emisión de eventos para creación, asignación, corrección, ejecución, rechazo e intento fallido.
- Visualización de la cadena de eventos en el detalle de la propuesta.
- Endpoint `GET /v1/purchase-command-proposals/:id/projection` y ruta BFF equivalente para reconstruir estado operativo y contrastarlo con tablas actuales.
- Contraste de estado, asignación actual, correcciones, intentos fallidos y ejecución, con lista explícita de discrepancias.
- UI de proyección contrastada con validez de cadena, número de eventos, resumen proyectado y coincidencia con estado actual.

Fuera de alcance:

- Proyecciones persistidas/materializadas; por ahora se reconstruyen bajo demanda.
- Taxonomía fina por regla de negocio concreta; por ahora se guarda una categoría estructurada general.
- Aprendizaje o modificación automática de reglas a partir de correcciones.

Validación local:

- Prisma Client regenerado.
- API: unitarias específicas de propuestas correctas; lint y build correctos.
- Web: unitarias específicas de propuestas correctas; lint y build correctos.
- Prisma schema validado con URL ficticia.

## Corrección de pruebas en staging — 2026-10-01

- `docker-compose.staging.yml` pasa `AI_NATIVE_ENABLED` a la API, apagado por defecto.
- `POST /api/purchase-proposals` valida un contrato estricto y reenvía la creación a la API con tenant y actor de la sesión. No permite seleccionar handler, empresa o usuario.
- Archivos afectados: Compose staging, ruta BFF, `purchase-proposals.ts` y sus tests.
- No añade formulario UI ni conectores IA. Las pruebas deben crear propuestas por API, no con inserciones administrativas directas.
- Validación: 7 unitarias web de propuestas correctas; lint y build web correctos. No se ejecutó integración PostgreSQL ni despliegue remoto para esta corrección.

## 2026-10-01 — Claridad de revisión y consistencia visual

- Detalle organizado en documento/propuesta, revisión de datos y decisión, con explicación de los efectos de crear un borrador.
- Selector de proveedores por nombre e identificación fiscal, paginado y aislado por empresa. Si un proveedor no está disponible, se conserva el UUID original.
- JSON, hashes, eventos e historial técnico quedan en paneles plegados; los documentos permanecen accesibles.
- Estilos consistentes para botones, campos, espaciados, foco y pantallas pequeñas en `proposals.css`.
- Resultado explícito: creación de borrador no equivale a aprobación, contabilización ni envío a AEAT. No se atribuye generación automática a una IA.
- La proyección se refresca después de decisiones y errores.
- Archivos: detalle web, estilos y selectores de aceptación Chromium; documentación temática actualizada.
- Validación: 52 unitarias web, lint y build correctos. Selectores E2E actualizados; no se ejecutó Chromium ni integración PostgreSQL en este avance.
- Fuera de alcance: lector de documentos/LLM, totales fiscales estimados y cambios del flujo de aprobación.

## 2026-10-01 — Terminología de facturas recibidas

- Navegación «Revisar facturas recibidas», bandeja «Revisión de facturas recibidas» y detalle «Revisar factura recibida».
- Se aclara que es una propuesta de registro, no una solicitud de compra ni aprobación de gasto, y que la entrada manual sigue en Compras.
- Archivos: app-shell, lista/detalle web, selectores E2E y documentación temática 25.
- Rutas, permisos, esquema y contratos API sin cambios; no incorpora extracción automática ni conectores IA.
- Validación: 52 unitarias web, lint y build correctos. Chromium e integración PostgreSQL no ejecutados en este cambio.

## 2026-10-01 — Entrada supervisada desde imagen con OCR local

- Nueva pantalla `/compras/propuestas/nueva`: imagen, texto/campos extraídos, proveedor por nombre, datos revisados y confirmación invalidable al editar.
- API/BFF `ocr-preview` usa Tesseract español local; `from-document` guarda propuesta y original bajo una transacción compartida con evidencia SHA-256 calculada por servidor.
- Límites: 10 MiB, 8000 píxeles por lado, 20 megapíxeles; worker serializado y cola máxima de tres. Permisos y `AI_NATIVE_ENABLED` mantienen el piloto restringido.
- Archivos: servicio/controlador de entrada, motor OCR y validador de dimensiones, página/bandeja, BFF y pruebas; documentación 25.
- Validación: API 45 suites/217 tests, web 13 archivos/56 tests, lint y build de ambos correctos. Cuatro pruebas Chromium de entrada/permisos con API simulada pasaron en servidor web local sin DB. Prueba real de Tesseract sobre imagen sintética española reconoció número, fecha, base y total (confianza 95 %).
- No se ha ejecutado integración PostgreSQL ni verificado el flujo completo en staging. Las pruebas mock de rollback solo comprueban propagación de errores y límite transaccional, no persistencia real.
- Límites funcionales: PNG/JPEG, extracción bruta transitoria, línea inicial EUR/cantidad 1/deducción 100 % corregible en revisión. Sin PDF, desglose automático, decisiones fiscales, proveedor automático ni aprobación autónoma.
- Sin cambios de esquema ni migraciones; no requiere proveedor externo ni credenciales OCR.

## 2026-10-02 — Documentos custodiados en cadena de eventos

- La escritura de eventos de propuestas queda centralizada en `PurchaseCommandProposalEventsService` para reutilizarla desde varios adaptadores internos.
- Las subidas nuevas de documentos custodiados emiten `command_proposal.document_uploaded` con documento, hash, tipo y tamaño.
- La proyección operativa incorpora y contrasta el recuento de documentos reconstruido desde la cadena frente a las tablas actuales.
- Archivos: servicios de propuestas/documentos, módulo de compras y documentación de base.
- Validación: unitarias API específicas de propuestas y documentos correctas: `npm test --workspace=@pastagansa/api -- purchase-command-proposals.service.spec.ts purchase-proposal-documents.service.spec.ts --runInBand`; builds API y web correctos.
- Fuera de alcance: migración retroactiva de eventos para documentos ya existentes.

## 2026-10-02 — Proyección materializada de propuestas

- Nueva migración `202610020001_command_proposal_projections` con tabla `command_proposal_projections`, RLS, aislamiento por empresa, FK tenant y backfill desde propuestas/eventos existentes.
- Cada evento nuevo actualiza la proyección materializada con estado, asignación actual, contadores, ejecución y último hash/secuencia.
- El endpoint de proyección sigue reconstruyendo desde la cadena y ahora contrasta también contra la proyección materializada.
- La bandeja muestra disponibilidad y secuencia de la proyección materializada.
- Validación: unitarias API específicas de propuestas/documentos, lint y builds API/web, y `prisma validate` con `DATABASE_URL` ficticia correctos.
- Fuera de alcance: usar la proyección materializada como fuente de verdad o replay operativo; las tablas de negocio y la cadena siguen siendo las referencias de contraste.

## 2026-10-02 — Candidatos de aprendizaje gobernado

- Nueva migración `202610020002_command_learning_candidates` con tabla `command_learning_candidates`, estado pendiente/aprobado/rechazado, RLS e inmutabilidad de decisiones.
- Al ejecutar una propuesta corregida se crean candidatos por campo corregido con valor original, valor corregido, propuesta, revisión, comando y actor.
- Endpoints API para listar candidatos y aprobar/rechazar explícitamente bajo `command_proposal.review`.
- No hay aplicación automática, cambios de reglas legales ni inferencias fiscales; el slice solo conserva conocimiento candidato con procedencia y decisión humana.
- Archivos: migración, Prisma schema, servicios/controlador de propuestas y tests unitarios.
- Validación: unitarias API específicas, lint API, build API y `prisma validate` con `DATABASE_URL` ficticia correctos.
- Fuera de alcance en este slice: UI de gestión de candidatos y consumo operativo de candidatos aprobados.

## 2026-10-02 — UI de candidatos de aprendizaje

- Nueva ruta web `/compras/propuestas/aprendizaje` para listar candidatos pendientes/aprobados/rechazados.
- Los revisores pueden aprobar o rechazar candidatos con motivo obligatorio desde BFF estricto; la API conserva la autorización real.
- La bandeja de facturas recibidas enlaza a candidatos para usuarios con `command_proposal.review`.
- Archivos: rutas BFF `learning-candidates`, página web, contrato `purchase-proposals.ts`, estilos globales y documentación.
- Validación: unitarias web de contratos de propuestas, lint/build web correctos; gate Chromium mock añadido para decisión de candidato y lint correcto; unitarias/lint/build API y `prisma validate` correctos en el slice anterior.
- Fuera de alcance: aplicar candidatos aprobados a futuras propuestas.

## 2026-10-02 — Sugerencias de aprendizaje de solo lectura

- Nuevo endpoint `GET /v1/purchase-command-proposals/:id/learning-hints` para devolver candidatos aprobados que coinciden exactamente con valores actuales de una propuesta.
- Nueva ruta BFF `/api/purchase-proposals/:id/learning-hints` y visualización en el detalle de revisión como sugerencias gobernadas informativas.
- No aplica cambios en el payload, no modifica reglas fiscales y no altera futuras propuestas de forma automática.
- Validación: unitarias API del servicio de aprendizaje, lint/build API, unitarias web de contrato de propuestas y lint/build web correctos.
- Fuera de alcance: automatización de correcciones a partir de candidatos aprobados.

## Criterio a partir de ahora

Para cada avance nuevo:

1. Actualizar este registro con fecha, alcance, archivos/rutas afectadas y validación ejecutada.
2. Actualizar la documentación temática si cambia contrato API, permisos, migraciones, operación o garantías.
3. Dejar explícito qué queda fuera de alcance.
4. Registrar tests/build/lint ejecutados y cualquier limitación de entorno.

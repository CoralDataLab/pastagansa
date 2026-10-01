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

## Criterio a partir de ahora

Para cada avance nuevo:

1. Actualizar este registro con fecha, alcance, archivos/rutas afectadas y validación ejecutada.
2. Actualizar la documentación temática si cambia contrato API, permisos, migraciones, operación o garantías.
3. Dejar explícito qué queda fuera de alcance.
4. Registrar tests/build/lint ejecutados y cualquier limitación de entorno.

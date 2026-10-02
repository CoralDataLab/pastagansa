# Base de comandos y propuestas supervisadas — primera entrega

## Alcance y límites

Esta entrega es un piloto **API**, desactivado por defecto (`AI_NATIVE_ENABLED=false`).
No incorpora un LLM, conector de email, OCR PDF, bandeja gráfica ni aprendizaje automático.
No cambia la fuente de verdad: las tablas de negocio PostgreSQL siguen siendo autoritativas.
`CommandExecution` es un **recibo de ejecución**, no un event store reconstruible.

Comando disponible: **`registrar_factura_recibida`, versión 1**.
Su resultado es una compra **DRAFT**, con líneas y desglose fiscal calculados por el
servicio existente. No aprueba gasto, no registra pagos y no publica libro IVA/asiento/SIF.
La aprobación multinivel de compras sigue siendo una operación distinta.

## Arquitectura

```text
POST purchase-invoices ───────────────┐
                                     ↓
Propuesta → revisión autorizada → RegisterPurchaseCommandService
                                     ↓
                         CommandExecutorService
                   autorización + lock + idempotencia
                                     ↓
                          PurchasesService.create
                       mismas reglas de negocio actuales
                                     ↓
                  compra + auditoría + recibo + decisión
                         una transacción PostgreSQL
```

- `apps/api/src/tenancy/tenant-transaction.service.ts`: frontera transaccional sin
  dependencia HTTP. El interceptor HTTP la reutiliza. Si existe una transacción del
  mismo actor/tenant se une a ella; no admite cambiar de empresa/actor dentro de ella.
- `apps/api/src/commands/command-authorization.service.ts`: autorización desde
  Membership/Permission activos en BD, no desde `roleCodes` o metadatos de agente.
- `apps/api/src/commands/command-executor.service.ts`: serialización por
  empresa/commandId, hash canónico de nombre+versión+payload+evidencias, recibo del
  resultado y recuperación idempotente. Reautoriza también los reintentos.
- `apps/api/src/purchases/register-purchase-command.service.ts`: valida DTO incluso
  sin HTTP y ejecuta las reglas existentes. No acepta nombre de handler arbitrario
  desde el cliente. El namespace `proposal:` está reservado en la API directa.
- `apps/api/src/purchases/purchase-command-proposals.service.ts`: propuesta original
  normalizada inmutable, decisión y payload final separados, bloqueo de revisión
  concurrente. Un rechazo no crea factura; una ejecución fallida conserva la propuesta
  pendiente y revierte todos los efectos de esa transacción.

Los callers no HTTP son adaptadores **de confianza dentro del servidor**. Deben
establecer una identidad auténtica antes de invocar el ejecutor; la comprobación de
permisos no reemplaza la autenticación. El cliente API nunca puede elegir `userId`,
`organizationId` o `companyId` en el payload: se usa el contexto autenticado.

## Activación segura

1. Usar primero una BD de desarrollo/ensayo, no producción.
2. Generar Prisma Client y aplicar migraciones mediante el procedimiento habitual.
   La migración nueva es
   `apps/api/prisma/migrations/202610010001_command_foundation/migration.sql`.
3. Configurar `AI_NATIVE_ENABLED=true` en **la API** y reiniciarla.
4. Probar con un actor que solo proponga y otro autorizado para revisar.

Con el flag desactivado, `POST /v1/purchase-invoices` conserva el comportamiento
anterior (sin recibos de comandos) y los endpoints de propuestas no están operativos.
La migración es aditiva, no reclasifica ni altera documentos anteriores.
Desactivar el flag no borra propuestas/decisiones/recibos, pero impide usar sus endpoints.

## Permisos

| Acción                              | Permisos                                              |
| ----------------------------------- | ----------------------------------------------------- |
| Proponer                            | `command_proposal.create`                             |
| Leer/listar propuestas              | `command_proposal.read`                               |
| Rechazar                            | `command_proposal.review`                             |
| Ejecutar propuesta y crear borrador | `command_proposal.review` + `purchase_invoice.create` |
| Crear borrador directamente         | `purchase_invoice.create`                             |

La migración añade los permisos al rol `organization.owner`; el alta de nuevos owners
los incluye también. No hay UI de gestión de roles en esta entrega.
**No otorgar review/create de compra a la credencial de un agente que solo deba proponer.**
La API exige la autoridad de revisión, pero no puede demostrar por sí sola que una llamada
la hizo una persona: esa separación depende de las credenciales y del adaptador de revisión.
El piloto no obliga a que proponente y revisor sean personas distintas.

## API

Todas las llamadas necesitan Bearer y cabeceras tenant habituales. La respuesta a
creación conserva `201` incluso en un reintento idempotente.

### Proponer

`POST /v1/purchase-command-proposals`

```json
{
  "commandId": "purchase-proposal:document-123:v1",
  "payload": {
    "supplierId": "11111111-1111-4111-8111-111111111111",
    "supplierInvoiceNumber": "PROV-2026-001",
    "issueDate": "2026-09-01",
    "receivedDate": "2026-09-02",
    "currency": "EUR",
    "lines": [
      {
        "description": "Servicio profesional",
        "quantity": 1,
        "unitPrice": 100,
        "taxRate": 21,
        "deductiblePct": 100
      }
    ]
  },
  "evidence": [
    { "reference": "document:123", "description": "Factura original" }
  ],
  "provenance": {
    "channel": "UPLOAD",
    "agentId": "purchase-reader",
    "agentVersion": "1"
  }
}
```

- Payload compatible con `CreatePurchaseInvoiceDto`, incluidos suplidos/servicios UE.
- Nombre/versión del comando fijos en el servidor; no se pueden seleccionar por API.
- `commandId`: 1–128 caracteres ASCII imprimibles, sin espacios exteriores.
- Mismo ID/datos normalizados/procedencia/evidencias: devuelve propuesta existente.
  Mismo ID con datos diferentes: `409`.
- Se valida la estructura, no la elegibilidad fiscal del borrador. Las reglas de negocio
  completas se ejecutan al aceptar; un proveedor equivocado puede corregirse en revisión.
- `evidence` admite hasta 20 referencias, hash SHA-256 opcional y descripción.
  **No archiva documentos, no verifica el hash contra un binario y no descarga URLs.**
  Las referencias y `provenance` son metadatos declarados/no verificados, no autoridad.
  Declarar EMAIL/UPLOAD no implica que existan esos conectores.

### Bandeja API

- `GET /v1/purchase-command-proposals?status=PENDING_REVIEW&limit=50`
- `GET /v1/purchase-command-proposals/:id`

El listado devuelve las últimas propuestas (límite 1–100), sin paginación todavía.
El detalle incluye propuesta original, revisión, recibo, documentos, correcciones y asignaciones si existen.
No hay alertas/SLA en esta entrega.

### Documentos custodiados opcionales

- `POST /v1/purchase-command-proposals/:id/documents` con `multipart/form-data`, campo `file`.
- `GET /v1/purchase-command-proposals/:id/documents/:documentId/download`.

Solo PDF, PNG o JPEG, máximo 10 MiB por archivo y 20 por propuesta. Se calcula SHA-256
sobre el contenido, se rechaza si el tipo declarado no coincide con la firma y un reintento
con el mismo binario devuelve el metadato existente. No se admiten nuevos documentos tras una
decisión final. Las descargas verifican integridad antes de servir el binario.

### Asignar expediente

`GET /v1/purchase-command-proposals/assignees`

Devuelve usuarios con membresía activa en la empresa actual (`id`, correo y rol) para alimentar el selector de responsable. Exige permiso de revisión.

`POST /v1/purchase-command-proposals/:id/assign`

```json
{ "assignedToId": "00000000-0000-4000-8000-000000000000", "reason": "Revisión por administración" }
```

Solo se admiten propuestas pendientes. El asignado debe tener membresía activa en la empresa de la propuesta. Cada asignación se conserva como hecho inmutable con asignado, asignador, motivo y fecha; la última por fecha es la asignación operativa actual.

### Revisar y ejecutar

`POST /v1/purchase-command-proposals/:id/execute`

```json
{ "reason": "Documento contrastado; proveedor e IVA verificados" }
```

Para corregir, enviar además `payload` con **la factura completa corregida**, no un patch.
La propuesta original permanece intacta; `CommandReview.acceptedPayload` conserva
el payload aprobado, `reason`, revisor y fecha. Si hay cambios, `command_proposal_revisions`
registra payload anterior, payload corregido y rutas/campos modificados. Repetir la misma revisión devuelve el
resultado; intentar otra revisión sobre una propuesta terminal produce `409`.

Estado: `PENDING_REVIEW → EXECUTED`. Este estado significa que se creó un **borrador**,
no que la compra quedó aprobada. El recibo contiene la respuesta original de creación;
no se recalcula a partir de cambios posteriores de la factura.

Si falla una regla de negocio, no hay recibo ni revisión final ni factura parcial.
La propuesta continúa pendiente para corregirla o rechazarla. El diagnóstico del error
se devuelve al caller y se registra en `command_proposal_attempts` en una transacción posterior,
con payload intentado, motivo, actor, código estructurado y mensaje de error. Si el registro del intento falla,
no enmascara el error de negocio original.

### Candidatos de aprendizaje gobernado

- `GET /v1/purchase-command-proposals/learning-candidates?status=PENDING_REVIEW`
- `POST /v1/purchase-command-proposals/learning-candidates/:candidateId/approve`
- `POST /v1/purchase-command-proposals/learning-candidates/:candidateId/reject`

Cada candidato procede de una corrección revisada y conserva campo, valor original,
valor corregido, propuesta, revisión y actor. Aprobarlo o rechazarlo registra una decisión
humana auditada; no cambia reglas fiscales, prompts, OCR ni futuras propuestas.
`GET /v1/purchase-command-proposals/:id/learning-hints` expone sugerencias de solo
lectura cuando un candidato aprobado coincide exactamente con el valor actual de la
propuesta; el revisor decide si corrige el payload. Cualquier automatización posterior
requerirá una política autorizada y pruebas de conformidad.

### Rechazar

`POST /v1/purchase-command-proposals/:id/reject`

```json
{ "reason": "Documento duplicado; no debe registrarse" }
```

Estado: `PENDING_REVIEW → REJECTED`. Motivo obligatorio, decisión inmutable.
No se elimina la propuesta ni se crea una compra. Para replantear una propuesta terminal,
crear otra con nuevo `commandId`; todavía no hay enlace `supersedesProposalId`.

### Creación directa existente

Con el piloto activo, `POST /v1/purchase-invoices` pasa por el mismo ejecutor/handler.
Admite `Idempotency-Key` opcional como commandId. Sin cabecera, el servidor genera un
UUID: mantiene compatibilidad, pero el cliente no puede deduplicar un reintento de red.
Con cabecera, misma intención devuelve el recibo original; cambio de datos/evidencias
con misma clave se rechaza. El cliente directo no envía evidencias en esta entrega.

## Persistencia y garantías

- `CommandProposal`: original normalizado, evidencia/procedencia, proponente y estado.
- `PurchaseProposalDocument`: PDF/PNG/JPEG custodiado opcional, hash SHA-256 y metadatos; no se puede modificar ni borrar.
- `CommandReview`: una decisión final por propuesta, aceptado/rechazado, motivo/actor/fecha.
- `CommandExecution`: un éxito por empresa/commandId, contrato/hash/resultado/actor/fecha. En ejecuciones desde propuesta, el recibo incorpora también evidencias de documentos custodiados.
- `CommandProposalEvent`: cadena append-only por propuesta con secuencia, hash del payload, hash propio y hash anterior para reconstruir el expediente supervisado, incluidos documentos custodiados añadidos a la propuesta.
- `command_proposal_projections` mantiene una proyección materializada operativa por propuesta, actualizada al añadir eventos y reconstruible desde la cadena.
- `GET /v1/purchase-command-proposals/:id/projection` reconstruye una proyección operativa desde la cadena y la contrasta con la proyección materializada y las tablas actuales, devolviendo discrepancias explícitas, incluido el recuento de documentos custodiados.
- SQL impide borrar propuestas, modificar originales, reabrir estados terminales o
  mutar recibos/decisiones. La consistencia propuesta–decisión–recibo se comprueba al commit.
- FK tenant entre propuesta/decisión/recibo; comprobación de empresa/organización.
- RLS para las tres tablas exige **organización y empresa**, además de filtros de servicio.
- No hay replay operativo ni outbox nuevo; los eventos de propuesta documentan el expediente y no sustituyen las tablas de negocio ni activan ejecución fiscal automática.
- Las correcciones pueden generar candidatos de aprendizaje gobernado en `command_learning_candidates`; quedan pendientes hasta aprobación/rechazo humano y no modifican reglas legales ni se aplican automáticamente.
- Los borradores de compra siguen editándose/borrándose por el flujo existente. El recibo
  conserva la respuesta de creación incluso si después el borrador cambia o se retira.

## Verificación

- Unitarias: runner HTTP/no HTTP, cambio de contexto prohibido, permisos desde BD,
  idempotencia/colisiones, DTOs fuera HTTP, propuesta corregida/rechazada y fallo sin decisión.
- Integración PostgreSQL: `apps/api/test/command-foundation.e2e-spec.ts`, para BD desechable
  migrada y DATABASE_URL con rol app (sin bypass RLS); autorización propuesta-only,
  concurrencia, creación solo DRAFT, rollback, inmutabilidad y aislamiento entre empresas.
- Ejecutar: `npm test --workspace=@pastagansa/api`, `npm run build --workspace=@pastagansa/api`
  y, con el entorno de integración preparado,
  `npm run test:integration --workspace=@pastagansa/api -- --runInBand command-foundation`.

### Resultado de verificación (2026-10-01)

- PostgreSQL 17 en contenedor desechable, sin usar bases existentes.
- Las 62 migraciones se aplicaron correctamente, incluida la nueva base de comandos.
- Suite completa de integración: **3 suites / 13 pruebas**, incluidas las 7 del piloto,
  usando el rol de aplicación sin bypass RLS.
- Se corrigió la deserialización de resultados PostgreSQL `void` de los bloqueos advisory:
  las consultas convierten su resultado a `text`, sin cambiar el bloqueo transaccional.
- Unitarias: 199 API y 45 web; build y lint API correctos.
- El error de persistencia simulado en una prueba es intencionado: verifica el rollback
  conjunto de compra, recibo y decisión.
- El piloto permanece desactivado por defecto; no se migraron bases operativas.

## Siguiente entrega

1. **Implementado posteriormente:** [bandeja frontend de revisión](25_bandeja_revision_compras.md)
   con original, diferencias y validaciones.
2. **Implementado posteriormente:** custodia de documentos de entrada independiente de una compra ya creada.
3. **Implementado:** versiones/correcciones por campo al ejecutar una propuesta corregida y asignación del expediente.
4. **Implementado:** intentos fallidos persistidos fuera del rollback de negocio.
5. **Implementado:** eventos reconstruibles encadenados, proyección materializada y contraste bajo demanda para propuestas de comando.
6. **Primer slice implementado:** candidatos de aprendizaje con procedencia desde correcciones y aprobación/rechazo explícitos; pendiente consumo operativo posterior bajo política autorizada. Nunca modificar invariantes legales
   a partir de una corrección sin política autorizada.

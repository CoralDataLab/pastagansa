# U6 — Operativa de documentos y cobros

## Decisión y límite de alcance

U6 mejora la operativa diaria sin alterar las reglas fiscales ni la semántica de
emisión. Se divide en dos entregas:

- **U6A — Documentos reales y comunicación**, recomendable antes de retomar
  VERI*FACTU y limitada a los issues U6-01, U6-02 y U6-03.
- **U6B — Cartera de cobros**, planificada y preparada, pero subordinada al calendario
  de VERI*FACTU. Incluye U6-04 a U6-07.
- **U6-08 — Aceptación y operación** cierra cada entrega que llegue a staging.

El punto de control se sitúa al terminar U6A. No se inicia U6B si U6A supera doce
días-persona, si aparece una regresión en emisión o si VERI*FACTU necesita absorber la
capacidad restante.

Estimación orientativa:

| Bloque | Issues | Estimación |
| --- | --- | ---: |
| U6A | U6-01 a U6-03 | 7–10 días-persona |
| U6B | U6-04 a U6-07 | 12–18 días-persona |
| Cierre operativo | U6-08 | 2–3 días-persona por entrega |

Las estimaciones incluyen API, web, migraciones, pruebas y documentación, pero no el
tiempo externo de alta de proveedor SMTP o configuración DNS.

## Resultado observable

Una empresa configura una sola vez sus datos fiscales, marca y cobro; crea un
presupuesto o factura cuyos datos históricos no cambian al modificar después la
empresa; lo envía desde Pastagansa; y puede seguir los vencimientos y las acciones de
cobro desde una bandeja única.

## Principios de diseño

1. Los documentos emitidos no dependen de datos vivos de la empresa para regenerar su
   PDF.
2. Los eventos de entrega y cobro son append-only, idempotentes y auditables.
3. Un estado externo informado por email, usuario, banco o futura plataforma B2B
   conserva siempre su fuente.
4. Ningún recordatorio se envía automáticamente sin activación expresa de la empresa.
5. U6 no implementa XML VERI*FACTU, QR, remisión AEAT ni factura electrónica B2B.
6. Los contratos se preparan para UBL/EN16931 y estados B2B sin acoplarlos al proveedor
   o plataforma que se seleccione más adelante.

---

## U6-01 — Perfil comercial y fiscal de empresa

**Prioridad:** P0  
**Tamaño:** M, 2–3 días-persona  
**Dependencias:** ninguna  
**Entrega:** U6A

**Estado real (15/09/2026):** implementado localmente y validado con builds, lint,
pruebas unitarias e integración PostgreSQL. El perfil uno-a-uno y el logo dedicado son
tenant-scoped, están protegidos por RLS de empresa, validan IBAN, color y contenido
binario PNG/JPEG, y quedan accesibles desde `Configuración > Empresa y documentos`.
La pantalla permite guardar, sustituir/eliminar logo y revisar una previsualización no
fiscal. Quedan para el gate U6A el E2E de navegador, la validación de restore drill en
staging y el consumo de snapshots por U6-02.

### Historia

Como propietario de una empresa quiero configurar una vez los datos que aparecen en
mis documentos para no editar textos ni depender de valores hardcodeados.

### Alcance

- Ampliar el perfil de empresa con:
  - domicilio fiscal: línea 1, línea 2, código postal, localidad, provincia y país;
  - email, teléfono y web;
  - nombre comercial opcional;
  - IBAN o cuenta bancaria predeterminada;
  - instrucciones y plazo de pago predeterminados;
  - notas y pie de documento predeterminados;
  - color principal validado;
  - logotipo PNG o JPEG.
- Crear una pantalla `Configuración > Empresa y documentos` accesible desde el shell.
- Mostrar una previsualización no fiscal con datos de ejemplo.
- Permitir eliminar o sustituir el logotipo.

### Reglas y casos borde

- El NIF sigue sin poder modificarse desde este formulario.
- El IBAN se normaliza y valida con checksum antes de guardarlo.
- El color se limita a formato hexadecimal y debe mantener contraste suficiente en el
  PDF; el texto crítico nunca dependerá solo del color de marca.
- El logotipo tiene un máximo de 512 KiB, dimensiones máximas definidas y firma binaria
  verificada. No se admite SVG por su superficie de ataque y variabilidad de render.
- Eliminar el logo no modifica documentos que ya hayan congelado su snapshot.
- Ningún campo nuevo se considera fiscalmente obligatorio sin validación del alcance
  normativo aplicable a la empresa.

### Datos y API

- Crear `CompanyDocumentProfile` uno-a-uno y tenant-scoped o ampliar `Company` si la
  migración conserva una separación clara entre identidad y presentación.
- Almacenar el logotipo en una entidad dedicada con MIME, tamaño, SHA-256 y bytes. No
  introducir object storage solo para este activo.
- Extender `GET/PATCH /v1/companies/current`.
- Añadir `PUT/DELETE /v1/companies/current/logo` con validación de contenido.
- La migración debe ser aditiva, admitir perfiles vacíos y aplicar RLS/grants.

### Permisos, auditoría y observabilidad

- Lectura: cualquier miembro de la empresa.
- Escritura: `company.update`.
- Auditar campos modificados sin registrar bytes, IBAN completo ni contenido sensible.
- Métricas de errores de carga por tipo y tamaño, sin etiquetar por empresa.

### Criterios de aceptación

- [ ] Un propietario guarda todos los campos y los recupera tras recargar.
- [ ] Un usuario sin `company.update` recibe `403` y la UI no ofrece edición.
- [ ] Un archivo renombrado con firma no permitida es rechazado.
- [ ] Un IBAN inválido no se persiste.
- [ ] Dos empresas de la misma organización no ven ni reutilizan sus perfiles.
- [ ] El formulario funciona con teclado, tiene errores asociados a campo y supera axe.
- [ ] La migración pasa desde una base con los 31 cambios actuales y su restore drill.

### Pruebas mínimas

- Unitarias de normalización, color, IBAN y firma de imagen.
- Integración de RLS, permisos, auditoría y sustitución concurrente del logo.
- Componente web para éxito, error, permisos y eliminación.
- E2E de configuración y persistencia.

### Fuera de alcance

- editor visual libre, múltiples plantillas, fuentes subidas por usuario y SVG;
- localización completa o múltiples idiomas;
- almacenamiento de adjuntos empresariales generales.

---

## U6-02 — Snapshots inmutables y PDFs configurables

**Prioridad:** P0  
**Tamaño:** M, 3–4 días-persona  
**Dependencias:** U6-01  
**Entrega:** U6A

**Estado real (15/09/2026):** implementado localmente y validado con migración,
integración PostgreSQL, suites unitarias, lint, builds y render visual de una factura de
cuatro páginas. Facturas y presupuestos guardan un snapshot versionado y una copia del
logo sin exponer sus bytes en API. Las facturas lo actualizan en borrador y lo congelan
al emitir; los presupuestos lo actualizan en borrador y lo congelan al enviar. El
backfill de facturas usa solo emisor legal/NIF históricos y el de presupuestos queda
marcado como incompleto, sin inventar datos desde el perfil vivo. Quedan para el gate
U6A el E2E de navegador, restore drill de staging y el flujo de email de U6-03.

### Historia

Como responsable administrativo quiero que una factura o presupuesto conserve los
datos con los que fue emitido o enviado aunque la empresa cambie después de dirección,
cuenta bancaria o imagen de marca.

### Alcance

- Definir un `issuerSnapshot` canónico y versionado con identidad, domicilio, contacto,
  pago, textos y referencia al contenido exacto del logo.
- En factura:
  - refrescar el snapshot mientras sea borrador;
  - congelarlo dentro de la misma transacción de emisión;
  - regenerar siempre el PDF emitido desde el snapshot congelado.
- En presupuesto:
  - refrescar el snapshot durante la edición en borrador;
  - congelarlo al pasar por primera vez a `SENT`;
  - mantenerlo al aceptar, rechazar, caducar o convertir.
- Renderizar logo, dirección, contacto, IBAN, condiciones y pie en factura y
  presupuesto, omitiendo limpiamente campos vacíos.
- Mantener el diseño actual y la paginación multipágina.

### Reglas y casos borde

- Una factura emitida no consulta el perfil vivo al generar su PDF.
- Un presupuesto enviado solo puede adoptar los nuevos datos creando una nueva versión
  o volviendo a borrador mediante un flujo explícito futuro; U6 no habilita esa vuelta.
- Si el logo histórico se elimina del perfil, el snapshot conserva los bytes o una
  referencia inmutable no eliminable mientras exista un documento.
- Los documentos existentes se rellenan con sus campos históricos conocidos. Para
  datos inexistentes no se inventa un valor usando silenciosamente el perfil actual.
- Rectificativas capturan su propio snapshot y mantienen la referencia documental a la
  factura original.

### Datos y API

- Añadir snapshot JSON versionado o columnas explícitas más una entidad de asset
  inmutable. La decisión debe registrarse en ADR antes de migrar.
- Backfill determinista:
  - facturas: partir de `issuerLegalName` y `issuerTaxId` ya congelados;
  - presupuestos: conservar un snapshot mínimo y marcar el origen del backfill;
  - no completar dirección o IBAN históricos con datos actuales.
- Incluir `snapshotVersion` para permitir evolución posterior.
- No exponer bytes del logo en respuestas de listado.

### Permisos, auditoría y observabilidad

- Reutilizar permisos actuales de documento y PDF.
- Auditar congelación y versión de snapshot, no su contenido completo.
- Registrar errores de render con request ID y tipo de documento.

### Criterios de aceptación

- [ ] Cambiar la empresa después de emitir no cambia los datos ni la representación
      visual del PDF de la factura ya emitida.
- [ ] Un presupuesto enviado mantiene sus datos al modificar después el perfil.
- [ ] Un borrador actualizado adopta explícitamente el perfil vigente.
- [ ] Factura, rectificativa y presupuesto muestran correctamente perfiles completos,
      parciales y sin logo.
- [ ] PDFs de una y cuatro páginas no presentan solapes, cortes ni pies duplicados.
- [ ] El backfill conserva todos los documentos actuales y no altera sus totales.

### Pruebas mínimas

- Integración para congelación transaccional y concurrencia entre actualización de
  empresa y emisión.
- Golden tests de snapshot y regresión de inmutabilidad.
- Render a PNG e inspección visual de factura, rectificativa y presupuesto, incluyendo
  multipágina y textos largos.
- E2E de cambio de empresa antes y después de emisión/envío.

### Fuera de alcance

- firma electrónica del PDF;
- Facturae, UBL, QR o remisión AEAT;
- diseñador de plantillas drag-and-drop.

---

## U6-03 — Entrega unificada de facturas y presupuestos por email

**Prioridad:** P0  
**Tamaño:** M, 2–3 días-persona más configuración externa  
**Dependencias:** U6-02  
**Entrega:** U6A

**Estado real (17/09/2026):** implementado y aceptado en staging. El outbox único conserva las
entregas históricas de factura y admite presupuestos, con PDF del snapshot adjunto,
destinatario/plantillas configurables, idempotencia, leases, reintentos e historial
visible tras recargar. La aplicación explica la indisponibilidad y mantiene descarga
PDF si SMTP no está configurado; staging entregó presupuesto, factura y recordatorio
con PDF al buzón controlado y el gate E2E remoto pasó 3/3. La web conserva la
misma clave idempotente para un reintento del mismo documento, destinatario y asunto;
cambiar el destinatario o asunto inicia explícitamente una entrega distinta.

### Historia

Como usuario comercial quiero enviar facturas y presupuestos desde Pastagansa y saber
si el servidor de correo aceptó la entrega para no descargar y adjuntar PDFs
manualmente.

### Alcance

- Generalizar el outbox existente para admitir `INVOICE` y `QUOTE` sin perder entregas
  históricas.
- Añadir envío e historial en el detalle de presupuesto.
- Incorporar asunto y cuerpo predeterminados configurables con variables permitidas.
- Adjuntar el PDF generado desde el snapshot del documento.
- Mantener estados `PENDING`, `PROCESSING`, `SENT` y `FAILED`, con reintentos acotados.
- Configurar SMTP real en staging/producción y documentar el procedimiento.
- Mostrar capacidad no disponible sin presentar el envío como completado.

### Reglas y casos borde

- Una clave idempotente no puede crear dos entregas.
- Enviar un presupuesto en borrador lo marca `SENT` cuando SMTP acepta la entrega; la
  transición manual existente continúa disponible y un fallo no altera el estado
  previo.
- La factura conserva su máquina de estados contable; el fallo de email no revierte la
  emisión.
- Reintentar utiliza el mismo snapshot y la misma versión del documento.
- El destinatario por defecto viene del snapshot del contacto, pero se permite cambiar
  para esa entrega sin alterar el contacto.
- No se incluyen píxeles de seguimiento ni detección de apertura.
- No se envían recordatorios automáticos en U6A.

### Datos y API

- Crear `DocumentDelivery` polimórfico o una relación tipada que garantice exactamente
  un documento origen. Migrar `InvoiceEmailDelivery` sin perder historial.
- Añadir endpoints equivalentes para presupuestos y mantener compatibilidad temporal
  con los endpoints de factura existentes.
- Persistir versión de plantilla, destinatario, asunto, intentos, proveedor y message ID
  sanitizado.
- El cuerpo completo puede conservarse si existe política de retención explícita; de lo
  contrario se almacena solo la plantilla y parámetros no sensibles.

### Permisos, auditoría y observabilidad

- Requerir permisos de lectura del documento y `document.send`.
- Auditar cola, envío, fallo y reintento.
- Métricas: profundidad de cola, latencia, intentos, enviados y fallidos.
- Logs sin cuerpo del correo ni PDF.
- Configurar SPF, DKIM y DMARC fuera de la aplicación y documentar su verificación.

### Criterios de aceptación

- [ ] Factura y presupuesto pueden enviarse desde sus detalles.
- [ ] El destinatario recibe el PDF que coincide con la versión mostrada.
- [ ] Un doble clic o retry HTTP no duplica la entrega.
- [ ] Un fallo temporal reintenta y un fallo definitivo queda visible y accionable.
- [ ] La UI muestra historial cronológico tras recargar.
- [ ] Sin SMTP la aplicación ofrece descarga y explica la indisponibilidad.
- [ ] Staging envía una prueba controlada y no expone credenciales en logs.

### Pruebas mínimas

- Unitarias con mailer falso para éxito, fallo temporal y permanente.
- Integración de idempotencia, worker concurrente, RLS y migración del historial.
- Componentes de estados y diálogo accesible.
- E2E factura/presupuesto → enviar → entrega visible.

### Fuera de alcance

- portal público, firma del destinatario, WhatsApp o SMS;
- seguimiento de apertura;
- recepción de facturas por email.

---

## U6-04 — Registro append-only de eventos comerciales

**Prioridad:** P1  
**Tamaño:** M, 3–4 días-persona  
**Dependencias:** U6-03  
**Entrega:** U6B

### Historia

Como responsable administrativo quiero una cronología fiable de envío, aceptación,
rechazo y cobro para conocer el estado real del documento y preparar la futura factura
electrónica B2B.

### Alcance

- Crear eventos append-only para facturas y presupuestos:
  `SENT`, `DELIVERY_FAILED`, `ACCEPTED`, `REJECTED`, `DISPUTED`,
  `PARTIALLY_PAID`, `PAID` y `PAYMENT_PROMISED`.
- Conservar fuente `USER`, `EMAIL`, `BANK`, `SYSTEM` o `EINVOICE`, fecha efectiva,
  fecha recibida e identificador externo.
- Generar eventos desde entregas, pagos y conciliación sin duplicar la verdad económica.
- Mostrar una línea temporal común en el detalle del documento.
- Permitir registrar manualmente aceptación, rechazo, disputa y promesa de pago con
  comentario.

### Reglas y casos borde

- Los eventos no se editan ni eliminan; una corrección crea otro evento vinculado.
- Los eventos `PARTIALLY_PAID` y `PAID` se derivan de pagos persistidos y no pueden
  declararse manualmente.
- `ACCEPTED` o `REJECTED` manual exige usuario, fecha efectiva y fuente explícita.
- Una clave `(company, source, externalId)` evita duplicados de integraciones futuras.
- El estado resumen se deriva de reglas documentadas y nunca sustituye el estado
  contable/fiscal de la factura.

### Datos y API

- Crear `CommercialDocumentEvent` tenant-scoped con payload JSON versionado y enlaces
  opcionales tipados a factura o presupuesto.
- Añadir listado cursor-based y comando explícito para eventos manuales permitidos.
- Añadir índices por empresa, documento, tipo y fecha efectiva.

### Permisos, auditoría y observabilidad

- Lectura según permiso del documento.
- Registro manual con `collections.manage` o `quotes.manage` según el caso.
- Auditar el comando; el evento constituye además evidencia de dominio.
- Métrica de fallos de proyección del estado resumen.

### Criterios de aceptación

- [ ] Enviar, cobrar parcial y cobrar total produce una cronología ordenada y única.
- [ ] Un evento de pago no puede existir sin el pago que lo origina.
- [ ] Dos callbacks con el mismo external ID solo generan un evento.
- [ ] Un evento de otra empresa nunca es visible ni referenciable.
- [ ] El payload conserva `schemaVersion` y la fuente original.

### Fuera de alcance

- envío de estados a la solución pública B2B;
- webhooks de terceros;
- cálculo normativo del plazo de cuatro días.

---

## U6-05 — API de cartera y previsión de cobros

**Prioridad:** P1  
**Tamaño:** M, 3–4 días-persona  
**Dependencias:** U6-04 y vencimientos/cobros existentes  
**Entrega:** U6B

### Historia

Como responsable de tesorería quiero saber qué cobrar, cuánto está vencido y qué se
espera ingresar para priorizar el trabajo diario.

### Alcance

- Exponer resumen y listado de cartera con:
  - por vencer esta semana;
  - vencido 1–7, 8–30, 31–60, 61–90 y más de 90 días;
  - saldo por cliente;
  - previsión contractual a 30, 60 y 90 días;
  - última entrega, recordatorio, disputa o promesa de pago;
  - fecha de próxima acción.
- Filtros por fecha, cliente, tramo, responsable, estado y texto.
- Orden estable y paginación por cursor.
- Exportación CSV segura del resultado filtrado.

### Reglas y casos borde

- Todas las consultas aceptan `asOf` explícito y usan la zona horaria de empresa.
- Solo entran facturas emitidas con saldo positivo; rectificativas y cobros reducen el
  saldo según la verdad contable existente.
- Una factura en disputa sigue visible y se identifica; no se excluye del saldo.
- La promesa de pago modifica previsión operativa, no vencimiento contractual.
- Los totales deben cuadrar con la suma de las filas bajo el mismo filtro y snapshot de
  consulta.
- CSV neutraliza fórmulas y no incluye emails salvo permiso expreso.

### Datos y API

- Añadir `GET /v1/collections/summary`, `GET /v1/collections/invoices` y exportación.
- Materializar solo si las pruebas de carga demuestran que la consulta directa no cumple
  el objetivo; empezar con agregaciones PostgreSQL e índices.
- Añadir proyección o campos operativos para responsable y próxima acción únicamente si
  no pueden derivarse del último evento.

### Permisos, auditoría y observabilidad

- `collections.read` para consulta/exportación.
- `collections.manage` para acciones futuras.
- Auditar exportaciones con filtros y recuento, no con contenido.
- Medir latencia y tamaño de resultados.

### Criterios de aceptación

- [ ] Los tramos se calculan correctamente en límites de fecha y cambio horario.
- [ ] Cobro parcial y total actualizan saldo y resumen sin refresco manual del servidor.
- [ ] La suma por cliente y global coincide con los vencimientos pendientes.
- [ ] La exportación reproduce filtros y no ejecuta fórmulas al abrirse.
- [ ] Una consulta de 100.000 vencimientos cumple el presupuesto de rendimiento acordado
      antes del sprint.

### Pruebas mínimas

- Property tests de clasificación por tramo y saldo.
- Integración con pagos parciales, rectificativas, disputas, RLS y paginación.
- Prueba de rendimiento con datos sintéticos y plan de ejecución revisado.

---

## U6-06 — Bandeja web de cartera

**Prioridad:** P1  
**Tamaño:** M, 3–4 días-persona  
**Dependencias:** U6-05  
**Entrega:** U6B

### Historia

Como responsable de cobros quiero trabajar toda la cartera desde una única pantalla y
llegar al documento o cliente sin reconstruir el contexto manualmente.

### Alcance

- Añadir `Cartera` al shell.
- Mostrar totales por vencer, vencidos, prometidos y en disputa.
- Tabla con cliente, factura, vencimiento, días vencidos, saldo, última acción y próxima
  acción.
- Filtros compartibles en URL y estados de carga, vacío, error y permiso denegado.
- Panel lateral con cronología y acciones:
  - abrir factura o cliente;
  - registrar cobro;
  - registrar promesa, disputa o nota;
  - preparar recordatorio.
- Diseño responsive con alternativa usable a la tabla en móvil.

### Reglas y casos borde

- La interfaz no presenta una promesa como cobro.
- Los importes mostrados vienen del API; no se recalculan en cliente.
- Las acciones optimistas no alteran el saldo hasta confirmación del API.
- El foco vuelve al elemento accionado al cerrar panel o diálogo.

### Criterios de aceptación

- [ ] Un usuario identifica y abre la factura más vencida en menos de tres interacciones.
- [ ] Registrar un cobro desde Cartera actualiza fila, totales y cronología.
- [ ] Los filtros sobreviven a recarga y enlaces compartidos.
- [ ] La experiencia de teclado y lector de pantalla supera el recorrido definido.
- [ ] Un usuario sin permiso no recibe datos agregados ni detalle.

### Pruebas mínimas

- Componentes de filtros, estados, panel y acciones.
- E2E vencida → recordatorio preparado → promesa → cobro parcial → cobro total.
- Axe en escritorio y viewport móvil.

---

## U6-07 — Recordatorios manuales y reglas opt-in

**Prioridad:** P1  
**Tamaño:** M, 3–6 días-persona según automatización  
**Dependencias:** U6-03, U6-04 y U6-06  
**Entrega:** U6B

### Historia

Como responsable de cobros quiero enviar recordatorios coherentes y repetibles sin
perder control sobre destinatario, tono o frecuencia.

### Alcance base obligatorio

- Plantillas de aviso previo, primer vencido y segundo vencido.
- Previsualización con importe, número, vencimiento y datos bancarios.
- Envío individual desde factura y Cartera.
- Selección múltiple con confirmación y resumen por destinatario.
- Historial como evento `SENT` con propósito `PAYMENT_REMINDER`.
- Exclusión automática de facturas pagadas o sin saldo.

### Automatización opcional tras el gate base

- Reglas por empresa: días antes/después, plantilla y máximo de intentos.
- Activación expresa, simulación previa y botón de pausa global.
- Job idempotente diario según zona horaria de empresa.

### Reglas y casos borde

- Sin email de facturación se omite la factura y se informa el motivo.
- Las facturas disputadas se excluyen del envío masivo por defecto.
- Una promesa de pago vigente pausa automatismos, pero no impide un envío manual.
- Nunca se adjuntan documentos de otras facturas en un correo agrupado.
- La misma regla no envía dos veces para factura, fase y fecha lógica.
- Cambiar una plantilla no modifica el contenido histórico enviado.

### Datos y API

- Reutilizar `DocumentDelivery` con propósito y versión de plantilla.
- Añadir `ReminderPolicy` solo para la automatización opcional.
- Endpoint de simulación sin efectos y comando batch con clave idempotente.

### Permisos, auditoría y observabilidad

- `collections.manage` para envíos y políticas.
- Auditar simulación solo como métrica; auditar confirmación y cambios de política.
- Métricas por resultado sin emails ni identificadores personales.

### Criterios de aceptación

- [ ] El usuario ve el contenido exacto antes de confirmar.
- [ ] Un lote informa enviados, omitidos y fallidos sin perder resultados parciales.
- [ ] Doble clic o retry no duplica recordatorios.
- [ ] Pagadas, sin saldo y disputadas se tratan según las reglas anteriores.
- [ ] La automatización permanece desactivada por defecto.
- [ ] Pausar una política impide nuevos envíos sin borrar historial.

### Pruebas mínimas

- Unitarias de elegibilidad, plantillas y fechas lógicas.
- Integración de batch parcial, idempotencia y worker concurrente.
- E2E de previsualización, confirmación y resultado.

### Fuera de alcance

- SMS, WhatsApp, llamadas automáticas y agencias externas de recobro;
- cálculo o reclamación automática de intereses de demora;
- cargos bancarios o payment links.

---

## U6-08 — Gate de aceptación, migración y operación

**Prioridad:** P0 transversal  
**Tamaño:** S, 2–3 días-persona por entrega  
**Dependencias:** issues incluidos en cada release  
**Entrega:** U6A y U6B

**Estado real (17/09/2026):** U6-08 cerrado para U6A/U6B tras aceptación remota
3/3 sobre `bb337bb`, recepción de tres PDF en el buzón controlado y prueba moderada
administrativa sin incidencias. El log y los recuentos del restore drill remoto no
quedaron archivados; la validación aislada local/CI sí consta. Evidencia y operación en
[Aceptación y operación U6](12_aceptacion_u6.md).

### Objetivo

Cerrar cada entrega con evidencia reproducible, rollback compatible y operación segura
antes de exponerla a empresas reales.

### Alcance

- Actualizar seed demo con perfil, logo pequeño, vencimientos y eventos deterministas.
- Añadir E2E completo de U6A y, cuando corresponda, U6B.
- Ejecutar lint, build, unitarias, integración, E2E y auditoría de dependencias.
- Construir imágenes Docker desde el commit candidato.
- Crear backup predeploy y ejecutar restore drill post-migración.
- Verificar visualmente PDFs de una y varias páginas.
- Configurar y verificar SMTP con buzón controlado.
- Documentar secretos, rotación, métricas, alertas y procedimiento ante cola bloqueada.
- Ejecutar una prueba moderada con una persona administrativa distinta del autor.

### Criterios de aceptación U6A

- [x] Empresa → perfil → factura/presupuesto → PDF → email se completa sin consola.
- [x] Los datos y la representación visual del PDF histórico no cambian después de
      editar el perfil.
- [x] El correo recibido contiene el PDF esperado y la entrega aparece en historial.
- [x] La caída del proveedor no bloquea emisión ni descarga.
- [x] Backup y restore drill validan el nuevo número de migraciones.

### Criterios de aceptación U6B

- [x] Cartera → filtro vencidos → recordatorio → promesa → cobro se completa sin consola.
- [x] Totales de Cartera, factura, diario y banco no presentan diferencias.
- [x] Reintentos y concurrencia no duplican evento, correo ni cobro.
- [x] Las rutas críticas superan auditoría WCAG y prueba remota de staging.

### Rollback

- Las migraciones son forward-only y aditivas.
- Desactivar workers mediante configuración no elimina la capacidad de descargar PDFs.
- Si falla SMTP, conservar entregas pendientes/fallidas y volver al binario anterior sin
  perder historial.
- No revertir un snapshot congelado ni reconstruirlo desde datos actuales.

---

## Orden de ejecución y dependencias

```text
U6-01 Perfil de empresa
  └─ U6-02 Snapshots y PDFs
       └─ U6-03 Entrega por email
            └─ Gate U6A con U6-08

U6-03 Entrega ─┐
               ├─ U6-04 Eventos comerciales
Pagos actuales ┘       └─ U6-05 API Cartera
                           └─ U6-06 UI Cartera
U6-03 + U6-04 + U6-06 ─────└─ U6-07 Recordatorios
                                  └─ Gate U6B con U6-08
```

U6-01 y el diseño de U6-03 pueden comenzar en paralelo, pero U6-03 no se integra hasta
que U6-02 defina qué versión del PDF debe adjuntar. U6-05 puede diseñarse contra los
vencimientos actuales, aunque su integración espera a U6-04 para no introducir una
segunda cronología incompatible.

## Corte recomendado antes de VERI*FACTU

Completar **U6A**, desplegarlo y volver a SIF/VERI*FACTU. U6B solo debe entrar antes si
se mantiene intacta la fecha de inicio del siguiente bloque SIF y existe capacidad
separada. Facturación recurrente, conciliación parcial/combinada, OCR PDF, portal de
cliente y espacio de gestoría quedan fuera de U6.

## Dependencias normativas a conservar

- El calendario vigente de RRSIF/VERI*FACTU sitúa la obligación en 2027 según el tipo
  de contribuyente; debe verificarse de nuevo al iniciar y cerrar U6A.
- La factura electrónica B2B es un proyecto separado. El Real Decreto 238/2026 define
  formatos estructurados y estados de aceptación, rechazo y pago; U6-04 prepara el
  dominio, pero no implementa su comunicación.
- La aplicación efectiva de factura electrónica B2B depende de la orden ministerial
  técnica y de los plazos contados desde su entrada en vigor. No se hardcodea una fecha.

Referencias oficiales:

- https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes.html
- https://www.boe.es/eli/es/rd/2026/03/25/238
- https://sede.agenciatributaria.gob.es/Sede/todas-noticias/2026/marzo/31/facturacion-electronica-obligatoria.html

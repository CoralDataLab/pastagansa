# Plan de producto usable

## Decisión

Desde septiembre de 2026, la prioridad inmediata de PastaGansa es convertir el
backend validado en una aplicación que una persona pueda utilizar sin herramientas de
desarrollo. La ampliación fiscal avanzada continúa en el roadmap, pero se retoma
después de superar este hito salvo que desbloquee un recorrido crítico.

Este plan es un overlay de entrega. No sustituye las fases funcionales ni cambia sus
estados: reorganiza el trabajo pendiente alrededor de resultados observables por el
usuario.

## Usuario y escenario inicial

El primer usuario objetivo es una pyme española de servicios con una empresa, IVA
nacional ordinario y un propietario que también administra la cuenta.

Al terminar el hito podrá:

1. registrarse o iniciar sesión;
2. reconocer la empresa activa y cambiar su configuración básica;
3. crear un cliente y un producto o servicio;
4. preparar, emitir y descargar una factura;
5. consultar su vencimiento y registrar un cobro;
6. registrar una factura de proveedor con adjunto, revisar OCR si procede y aprobarla;
7. registrar su pago;
8. comprobar el efecto básico en ventas, compras, saldo pendiente y contabilidad.

## Definición de producto usable

El hito solo se cierra cuando una persona no desarrolladora puede completar los dos
recorridos críticos desde un navegador, sin Swagger, SQL ni ayuda correctiva del
equipo:

```text
Venta
registro → cliente → servicio → borrador → emisión → PDF → cobro

Compra
proveedor → borrador → adjunto → OCR/revisión → aprobación → pago
```

Además:

- el entorno se levanta con instrucciones reproducibles;
- existe un dataset demo determinista y reiniciable;
- carga, vacío, error, permiso denegado y conflicto tienen estados comprensibles;
- ninguna acción crítica se presenta como completada antes de confirmación del API;
- los importes y fechas se muestran en formato español;
- teclado, foco, etiquetas y contraste cubren el recorrido crítico;
- una prueba E2E de navegador protege cada recorrido;
- existe un staging accesible, con logs, healthcheck y procedimiento de recuperación;
- no se exponen secretos ni datos demo reales.

## Arquitectura de entrega

Se añade `apps/web` al monorepo con Next.js, React y TypeScript, siguiendo la
especificación técnica existente. La primera versión utilizará:

- componentes accesibles y tokens definidos en la especificación UI/UX;
- TanStack Query para estado remoto;
- React Hook Form y Zod para formularios;
- un cliente tipado y una única capa para autenticación, tenant, errores e
  idempotencia;
- Playwright para recorridos E2E de navegador.

No se duplicarán reglas fiscales o contables en el frontend. El API sigue siendo la
fuente de verdad y la web muestra sus resultados y conflictos.

## Plan de slices

### U0 — Arranque reproducible y demo

Resultado: cualquier colaborador puede levantar la aplicación y obtener una empresa
demo coherente con un procedimiento documentado.

Estado real: completada. Los comandos raíz levantan API y web; el stack reproducible
aplica migraciones y comprueba readiness; y el seed público crea una empresa, usuario,
cliente, proveedor, servicio, tres series y una cuenta bancaria. CI lo ejecuta dos veces
y exige que la segunda pasada reutilice los siete recursos. Las credenciales, recorridos
y reinicio destructivo limitado al volumen local están documentados.

Entregables:

- comandos raíz para desarrollo coordinado de API y web;
- seed idempotente con empresa, usuario, cliente, proveedor, servicio, series y cuenta
  bancaria;
- configuración de desarrollo y comprobación de health;
- documento corto “probar el producto”;
- CI preparado para instalar y construir ambos workspaces.

Gate:

- repositorio limpio → instalación → base de datos → migraciones → seed → aplicación;
- las credenciales demo y la forma de reiniciar datos están documentadas;
- ejecutar el seed dos veces no duplica datos.

### U1 — Web foundation y acceso

Resultado: el usuario entra en una aplicación reconocible y aterriza en su empresa.

Estado real: en curso. Ya existen el workspace Next.js integrado en lint, build y
tests del monorepo; registro/login/logout; renovación de sesión mediante cookies
HTTP-only; descubrimiento autenticado de membresías bajo RLS; selección de la primera
empresa activa; shell responsive y estados de carga/error. Los E2E críticos ejercitan
el acceso, la persistencia de sesión y auditorías WCAG automatizadas con axe en acceso,
inicio y estados clave de venta y compra. El selector multiempresa solo aparece con más
de una membresía, valida el nuevo tenant en servidor y recarga todos los datos para no
mezclar cachés. U1 queda completada.
La recuperación de contraseña funciona sin SMTP mediante enlaces temporales generados
por el operador: el token se persiste como hash, solo admite un uso y el cambio revoca
todas las sesiones anteriores. La sección Seguridad permite además cambiar la
contraseña validando la actual, conservar solo la sesión en uso y revisar o cerrar las
demás sesiones; un E2E con dos navegadores protege el recorrido.

Pendiente cuando exista SMTP: convertir el inicio de la recuperación en autoservicio
desde la UI. `/recuperar` pedirá el correo y responderá siempre de forma genérica para
no revelar si la cuenta existe; la API generará el mismo token temporal y lo entregará
por email mediante outbox, sin incluirlo en respuestas ni logs. Debe conservar rate
limit, uso único, caducidad, revocación de sesiones y pruebas contra enumeración de
cuentas. Hasta entonces se mantiene únicamente la generación administrativa documentada.

La primera observación de uso externo detectó que un cliente no podía convertirse en
proveedor desde la web y llevaba a crear un duplicado. Se resolvió unificando el maestro
como Contactos, añadiendo filtros por rol, edición completa y una advertencia que deriva
al registro existente cuando coinciden nombre o NIF, además de archivado seguro para
retirar duplicados sin perder sus documentos históricos. La misma revisión detectó etiquetas
contables técnicas en inglés; la presentación traduce ahora tipos y descripciones,
incluidos los asientos históricos, sin modificar los datos contables persistidos.

Entregables:

- shell responsive, navegación principal y dirección visual lima;
- registro, login, persistencia/renovación de sesión y logout;
- contexto visible de organización y empresa;
- rutas protegidas y tratamiento de sesión caducada;
- cliente API, feedback de carga, errores y notificaciones;
- página inicial con próximos pasos reales, no métricas ficticias.

Gate:

- registro y login funcionan desde navegador;
- recargar conserva una sesión válida y una sesión revocada vuelve al login;
- nunca se consulta una empresa sin contexto tenant validado;
- pruebas de componentes críticos y E2E de acceso en CI.

### U2 — Venta usable

Resultado: el usuario convierte datos maestros en una factura real descargable.

Estado real: completada. Están disponibles la cartera de clientes y el catálogo de
productos/servicios, ambos con navegación desde el shell, búsqueda, paginación por
cursor, estados de carga/vacío/error y alta validada. El catálogo conserva precio,
unidad, IVA sugerido y cuenta de ingresos reutilizables. La web mantiene tokens y
tenant en servidor y presenta NIF o SKU duplicados como conflictos recuperables.
También existe listado de facturas por estado y creación de borradores con cliente,
fechas y múltiples líneas, reutilizando catálogo y mostrando el total confirmado por
el API. El detalle permite editar borradores, crear o seleccionar una serie, confirmar
la emisión idempotente y descargar el PDF oficial. El recorrido funcional se completa
con vencimiento, saldo, historial y registro idempotente de cobros parciales o totales.
El detalle enlaza y resume el asiento contable y el apunte del libro de IVA creados al
emitir. Un E2E de Chromium ejecutado en CI cubre registro, cliente, catálogo, borrador,
emisión, PDF y cobro, y recarga el documento para comprobar el estado persistido.

Entregables:

- listas y formularios mínimos de clientes y catálogo;
- listado, creación y edición de factura borrador;
- editor de líneas con totales devueltos por el API;
- selección de serie y emisión con confirmación explícita;
- detalle inmutable, descarga de PDF, vencimientos y registro de cobro;
- enlaces al asiento y Tax Ledger cuando existan.

Gate:

- E2E `cliente → factura → emisión → PDF → cobro`;
- doble clic o retry no duplica emisión ni cobro;
- errores de validación y conflicto indican cómo continuar;
- el estado mostrado tras recarga coincide con PostgreSQL.

Este gate constituye el **primer incremento usable** y tiene prioridad sobre U3 y U4.

### U3 — Compra usable

Resultado: el usuario registra y paga una compra con control humano del OCR.

Entregables:

- listado y editor de facturas de proveedor;
- subida y descarga de adjuntos;
- solicitud, progreso y reintento de OCR para PNG/JPEG;
- comparación clara entre extracción y corrección humana;
- aprobación simple o multinivel según política;
- vencimientos y registro de pago;
- enlaces al asiento y Tax Ledger.

Gate:

- E2E `proveedor → compra → adjunto → OCR/revisión → aprobación → pago`;
- nunca se aprueba una extracción pendiente de revisión;
- permisos y estado explican por qué una acción no está disponible;
- PDF se acepta como adjunto y no se ofrece falsamente como OCR compatible.

Estado real: completada. El recorrido web cubre proveedor → borrador editable →
adjuntos → OCR/revisión → aprobación → pago, con serie de recepción, IVA
soportado/deducible, saldo, historial y trazabilidad exacta hacia el asiento y el libro
de IVA. PDF, PNG y JPEG se suben y descargan; la interfaz solo ofrece OCR para PNG/JPEG,
muestra progreso y reintento y compara extracción con correcciones humanas. La
aprobación queda bloqueada hasta revisar cada OCR solicitado. Un E2E de Chromium
verifica el recorrido completo, el archivo descargado y la persistencia tras recarga.

### U4 — Visibilidad y staging

Resultado: los recorridos se pueden evaluar de forma autónoma en un entorno estable.

Entregables:

- inicio con ventas, compras y saldos pendientes básicos;
- vistas mínimas de diario, mayor y conciliación bancaria existente;
- capacidad de correo observable y alternativa explícita mediante descarga PDF;
- despliegue repetible de web, API y PostgreSQL;
- logs correlacionados, healthcheck, métricas y alertas mínimas;
- backup y restauración ensayados;
- guion de prueba moderada con al menos una persona ajena al desarrollo.

Gate:

- los E2E críticos pasan contra staging;
- una factura puede descargarse y compartirse sin depender de infraestructura de correo;
- restauración documentada y ensayada;
- cero bloqueadores de severidad crítica o alta en el recorrido usable;
- incidencias de la prueba moderada clasificadas antes de cerrar el hito.

Estado real: completada. El host `ledger.coraldatalab.com` responde mediante HTTPS. La
primera aceptación remota detectó permisos incompletos en el volumen; la migración 25
los reparó y readiness consulta ahora `users` para impedir que ese estado vuelva a
parecer sano. Tras el redespliegue, el 14/09/2026 pasaron 2/2 recorridos remotos de
ventas y compras, incluidas conciliación y auditorías WCAG. El inicio ya resume ventas
emitidas, compras aprobadas y saldos
pendientes de cobro/pago con agregados exactos y aislados por tenant. La navegación
incluye vistas read-only de diario y mayor por periodo y cuenta; el E2E de compra
comprueba que resumen y libros reflejan los movimientos contabilizados. La vista de
tesorería ya permite configurar la cuenta bancaria, importar un movimiento normalizado,
revisar sugerencias y confirmar una conciliación uno-a-uno. El detalle de venta detecta
si el correo está disponible, evita encolar entregas sin proveedor y ofrece la descarga
PDF como recorrido soportado; si se configura SMTP conserva el historial observable.
SMTP real queda aplazado por decisión de producto y deja de bloquear el hito. La prueba
moderada con una persona externa se completó y validó el 14/09/2026. Identificó una
incidencia media —no poder convertir un cliente en proveedor desde la web— y una baja
—etiquetas contables técnicas en inglés—; ambas quedaron resueltas y verificadas en
staging. El workflow manual de aceptación puede ejecutar los dos recorridos y auditorías WCAG
contra una URL HTTPS externa, con confirmación explícita de escritura. El guion moderado
define consignas, métricas, evidencias y severidades. El stack reproducible de
PostgreSQL, API y web construye imágenes desde el mismo commit, aplica 31 migraciones,
espera readiness real y supera el smoke test. El 10/09/2026 se ensayó localmente un dump
custom y su restauración aislada, verificando migraciones, tablas críticas y recuentos
de datos; CI repite ese ensayo en cada cambio.

### U5 — Presupuesto comercial usable

Resultado: el usuario prepara una oferta, comparte su PDF y registra la decisión del
cliente antes de facturar.

Estado real: completada. El API ya conservaba líneas, totales, snapshot del cliente,
PDF y transiciones atómicas. La web expone ahora listado paginado y filtrable, alta y
edición de borradores con catálogo o concepto libre, plazo de validez, condiciones,
descarga PDF y los estados enviado, aceptado, rechazado, caducado y cancelado. Un
presupuesto aceptado se convierte de forma atómica e idempotente en factura borrador,
copiando cliente, conceptos, condiciones e impuestos y manteniendo navegación entre
ambos documentos. El E2E de venta cubre creación, PDF, aceptación y conversión,
incluida una auditoría WCAG del borrador. Los presupuestos usan ya una serie
comercial configurable con asignación atómica y conservan ese número en listado,
detalle y PDF.
El 15/09/2026, el recorrido actualizado se desplegó en
`ledger.coraldatalab.com` después de un backup y superó los 3/3 E2E remotos de
venta, compra y seguridad, junto con las auditorías WCAG. Un segundo backup del
esquema actualizado superó el ensayo de restauración con las 31 migraciones.

Gate:

- E2E `cliente → catálogo → presupuesto → PDF → aceptación → factura borrador`;
- la conversión es idempotente y mantiene un enlace visible entre ambos documentos;
- un presupuesto que ya no es borrador no puede editarse;
- estado y documento convertido persisten tras recarga.

## Orden inmediato de implementación

1. Cerrar el gate U6A con U6-08: validar en staging perfil, snapshots/PDF y entrega
   por email contra un buzón controlado, ejecutar el restore drill y guardar la
   evidencia E2E/WCAG. U6-01, U6-02 y U6-03, incluida la entrega unificada de
   facturas y presupuestos, ya están implementados localmente; SMTP de staging queda
   configurado y pendiente de esa aceptación externa.
2. Continuar SIF/VERI*FACTU. La anulación append-only ya se incorpora como registro
   encadenado e idempotente, sin reescribir la factura ni sus efectos contables o de
   IVA. El exportador XML AEAT de alta F1 estándar y anulación ya está disponible para
   inspección, sin firma ni transmisión; el siguiente bloque es validarlo contra XSD y
   preparar la remisión al entorno de pruebas AEAT. U6B —cartera y recordatorios— no
   desplaza este punto de control.

El backlog detallado, dependencias y criterios de aceptación de U6 están en
[Operativa de documentos y cobros](09_plan_operativa_documentos_cobros.md).

## Alcance aplazado hasta superar el hito

- inversión del sujeto pasivo y casuística intracomunitaria avanzada;
- modelos fiscales y libros completos;
- SIF/VERI*FACTU (pausado hasta cerrar U5);
- pedidos, albaranes y recurrencia;
- conciliación parcial/combinada y Open Banking;
- dashboards analíticos avanzados;
- personalización visual amplia, dark mode y PWA;
- OCR PDF y sustitución del almacenamiento de adjuntos.

No se aplazan correcciones de seguridad, aislamiento tenant, integridad contable o
fiscal, pérdida de datos ni fallos que bloqueen los recorridos del hito.

## Métricas del hito

- tiempo desde registro hasta primera factura emitida;
- porcentaje de recorridos completados sin ayuda;
- errores de formulario por recorrido;
- abandonos por paso;
- fallos E2E y regresiones en CI;
- accesibilidad automática del recorrido crítico;
- errores 5xx y latencia percibida en staging.

Objetivo inicial: una persona familiarizada con facturación, pero no con el proyecto,
emite y descarga su primera factura en menos de diez minutos usando los datos demo.

## Regla para aceptar nuevo alcance

Hasta cerrar el Hito U, una nueva historia entra en prioridad solo si:

1. desbloquea uno de los recorridos críticos;
2. corrige seguridad, aislamiento, integridad o pérdida de datos;
3. reduce un riesgo operativo del staging;
4. es obligatoria por una fecha normativa anterior al cierre previsto del hito.

Cualquier otra capacidad permanece en el backlog original.

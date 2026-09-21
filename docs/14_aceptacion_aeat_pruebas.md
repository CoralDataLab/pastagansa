# Aceptación de remisión AEAT en staging — 18/09/2026

## Evidencia exportable y cobertura pendiente

La API ofrece `GET /sif/records/{recordId}/test-submissions/{submissionId}/evidence`
con permiso `sif_record.read`. Descarga un JSON acotado a la empresa con la respuesta
SOAP original conservada en el outbox, su SHA-256, el CSV recibido, el estado, la
identidad de factura, la huella SIF y el SHA-256 del XML enviado. Si hubo consulta
de conciliación, incluye también su respuesta y hash. El archivo contiene datos
fiscales: debe guardarse en un repositorio de evidencias con acceso restringido,
fuera de Git. Un campo SOAP nulo indica que esa respuesta no está archivada en
la base de datos; el endpoint no la reconstruye.

Para cada ensayo nuevo: descargar el XML congelado y la evidencia, comprobar los
hashes de ambos archivos, verificar que identidad, estado y CSV de la respuesta
SOAP coinciden con el JSON, y registrar la consulta independiente del CSV en la
sede AEAT con fecha y resultado. Una respuesta SOAP auténtica archivada permite
auditar lo recibido por la aplicación; **no equivale** a una consulta independiente
en la sede. Los ensayos históricos descritos abajo siguen pendientes de este
cotejo mientras no se exporten sus respuestas y se consulten sus CSV.

Cobertura observada en pruebas: F1 ordinaria, F1 con fecha de operación, R1 y R4
por diferencias, subsanación de aviso horario y anulación de alta rechazada.
Quedan por diseñar y validar con reglas fiscales y AEAT pruebas las demás causas
rectificativas, sustitución, otras claves de factura, desgloses y destinatarios
especiales. Cada caso requiere XML validado con XSD, resultado SOAP archivado y
comprobación fiscal del motivo; no se debe inferir cobertura de un F1 aceptado.

La integración VERI*FACTU de PastaGansa recibió una respuesta **Aceptado** para un
registro de alta F1 en el servicio de **pruebas** de la AEAT. La interfaz mostró el
registro SIF en posición 3, la cadena local verificada con tres registros y el CSV
`A-DS7J3EGMD6UAJ8`. La evidencia es la captura de la interfaz aportada por la
persona que ejecutó la prueba. En aquel momento no se había consultado el registro
directamente en el entorno de pruebas de la AEAT ni se había archivado aquí la
respuesta SOAP completa.

El 21/09/2026 se exportó localmente la evidencia conservada para esa remisión,
sin copiar datos fiscales al repositorio. El XML descargado de la posición 3
(`sif-3-registration.xml`) tiene SHA-256
`f7fee8072c05544780bcb24d177c04d0d249bf5dff5fbb7e881023609fe5023b`,
idéntico a `requestSha256` del JSON de evidencia. La respuesta SOAP extraída
del JSON tiene SHA-256
`4ab482353e8b2bf1526da5f8b0db641e6fc0ac5c4616589b71f96bfa8bbae789`,
idéntico a `responseSha256`. El SOAP archivado indica HTTP 200, `EstadoEnvio` y
`EstadoRegistro` **Correcto**, operación `Alta`, la identidad de `F2026-0003`
y el CSV citado. Este cotejo confirma la coherencia entre los archivos
descargados y la respuesta guardada por la aplicación; sigue pendiente la
consulta independiente del registro en el entorno AEAT de pruebas en el momento
de esta comprobación local.

Posteriormente, el operador aportó una captura de la consulta de registros del
entorno AEAT de pruebas: para `F2026-0003`, ejercicio 2026, mes 09, figura un
registro F1 con fecha de expedición 18/09/2026, remisión 18/09/2026 a las
08:56:33, cuota 2,10 €, importe 12,10 € y estado **Correcto**. La fecha y hora
coinciden con `TimestampPresentacion` del SOAP archivado; identidad, tipo e
importes coinciden con el XML congelado. El operador descargó además el CSV de
esa consulta (`query.csv`, SHA-256
`5e4a1f6b2090e36ed4e4abbafe435c79f1d019260f08c1bc10af6ac328f7e325`).
Su fila de `F2026-0003` confirma el estado **Correcto**, el tipo F1, la base
10,00 €, cuota 2,10 €, importe 12,10 €, emisor y fecha de expedición. La
huella completa coincide exactamente con `recordHash` del JSON y con la huella
del XML congelado. El CSV exportado muestra también un identificador de
petición; no se compara aquí con el SOAP de remisión porque esa respuesta no lo
incluye. Quedan cotejados de forma independiente identidad, contenido básico,
huella y estado de esta alta en AEAT pruebas. El CSV de respuesta
`A-DS7J3EGMD6UAJ8` solo se ve en el SOAP archivado; el CSV de exportación de
la consulta no contiene una columna para ese código.

La prueba se realizó en el staging aislado con un certificado de representante
montado en la API. El código del cliente SOAP fija el endpoint de pruebas
`prewww1.aeat.es`; no admite configurar una URL de producción. La captura no
acredita por sí sola el SHA exacto desplegado. Posteriormente, la persona que
administra staging comunicó como SHA de aquel despliegue
`954085ffe78dfccee4bc2f80f2aaa26b163495b8`; es un ancestro de
`581e4b0` y no incluía el nuevo flujo de anulación económica. El SHA se deja
constar como declaración del operador, sin comprobación SSH independiente.

El cambio `b99d684` se publicó en
`main` para que el outbox continuase después de un rechazo de registro confirmado;
su suite de API pasó 97 pruebas, además de lint y build.

Secuencia observada en la misma cadena de prueba:

1. Posición 1: alta rechazada por NIF/nombre del destinatario no identificado en
   el censo de la AEAT. El registro local permanece inmutable. Tras decidir anular
   esa factura de prueba, la captura posterior muestra una anulación aceptada en
   la posición 5.
2. Posición 2: alta **AceptadoConErrores**, CSV `A-WXJSWRTFEDXDNF`. La AEAT señaló
   que `FechaHoraHusoGenRegistro` estaba fuera del margen de 240 segundos. El
   outbox había retenido este registro mientras esperaba la aceptación de la
   posición 1; el reloj del servidor estaba sincronizado por NTP cuando se
   investigó el aviso. El alta original continúa figurando como aceptada con
   errores, como corresponde a un registro inmutable; la subsanación consta en
   la posición 4.
3. Posición 3: alta **Aceptado**, sin aviso mostrado, CSV
   `A-DS7J3EGMD6UAJ8`. La cadena local figuraba verificada.
4. Posición 4: alta de subsanación del aviso horario de la posición 2;
   **aceptada** según la interfaz, con CSV visible en la captura aportada.
5. Posición 5: registro de anulación de la factura cuya alta quedó rechazada
   en la posición 1;
   **aceptada** según la interfaz, CSV `A-4ZUSDMEB2RQ3VP` visible en la captura
   y cadena local verificada
   con cinco registros. El alta original sigue visible como rechazada.

La aceptación de la posición 3 demuestra el recorrido técnico de emisión,
congelación del XML, remisión autenticada y procesamiento de una alta F1 ordinaria
por el servicio de pruebas. Las capturas posteriores muestran en la interfaz la
aceptación de la subsanación y de la anulación de prueba. No certifican todas las
clases de factura ni habilitan el uso en producción. Antes de considerar completa
la recuperación general de errores quedan otros casos de subsanación y rechazo.
La revisión independiente de conformidad y la declaración responsable de cada
versión siguen pendientes.

## Recuperación en pruebas

Se añadieron dos acciones explícitas, sin remisión automática al desplegar:

- La anulación de un alta con respuesta de línea **Incorrecto** genera un nuevo
  registro con `SinRegistroPrevio=S`. Si el estado es un rechazo global sin línea,
  un fallo de transporte o un envío pendiente, la acción se bloquea. No altera la
  factura ni sus asientos o IVA.
- La subsanación del aviso de `FechaHoraHusoGenRegistro` de un alta
  **AceptadoConErrores** crea una nueva alta `Subsanacion=S` con la hora actual.
  Conserva el número, importes, XML y huella anteriores; enlaza el nuevo registro
  al alta original y al último registro de la cadena. No sirve para corregir datos
  económicos ni otros avisos.

Los XML se validaron con los XSD locales y las migraciones se aplicaron sobre un
PostgreSQL temporal aislado. La suite de API y la de integración pasaron. La
captura aportada del staging muestra **subsanación: aceptado** y cuatro registros
en la cadena local verificada. La captura siguiente muestra **anulación: aceptado**
en la posición 5 y cinco registros en la cadena local verificada. Estas respuestas
no se han contrastado directamente en la sede de la AEAT ni se han archivado aquí
los SOAP completos. Se inspeccionó el XML de anulación exportado como
`/Users/alberto/Downloads/sif-5-cancellation.xml`:

- SHA-256: `8d3c33b36fb53286d2b71a262de033c8d392b284e34e1f824e9f67c2e519d126`;
- contiene un `RegistroAnulacion`, `SinRegistroPrevio=S` y ningún `RechazoPrevio`;
- incluye huella propia y referencia a la huella del registro anterior;
- la huella propia coincide con el SHA-256 recalculado a partir de los campos
  prescritos por la especificación AEAT 0.1.2;
- `xmllint` lo validó con el XSD local `SuministroLR.xsd`.

La inspección del XML no sustituye el cotejo directo de la respuesta SOAP en la
AEAT ni una auditoría de conformidad. El archivo no se copia al repositorio
porque contiene identificadores fiscales. La acción SIF no modifica
la factura, la contabilidad ni el IVA; cualquier corrección económica se atiende
por separado.

## Anulación de factura emitida por error

La aplicación añade una acción específica para una factura ordinaria emitida
cuando **no existió la operación**. Conserva el número, PDF y alta originales;
reutiliza una anulación SIF ya creada (como la observada en la posición 5) o añade
una nueva. En la misma transacción marca la factura `CANCELLED`, deja su saldo
pendiente en cero, registra un apunte negativo vinculado al original en el libro
de IVA y crea un asiento contable de reversión. Guarda motivo, fecha y evento de
auditoría. Rechaza facturas con cobros o rectificativas y no sustituye el flujo
de factura rectificativa cuando sí existió la operación. Detiene los correos
pendientes de esa factura y espera a que termine cualquier envío en curso antes
de permitir la anulación.

La migración y las pruebas de integración pasaron en PostgreSQL local aislado,
incluyendo aislamiento entre empresas, reintento y reutilización de la anulación
SIF preexistente. El 18/09/2026, tras el nuevo despliegue, la captura de staging
mostró la factura de prueba de la posición 1 como **anulada** por operación
inexistente. La trazabilidad mostró el asiento original #1 y su reversión #4;
el libro de IVA conservó la base y cuota originales de 200,00 € y 42,00 € y
añadió un apunte de anulación de −200,00 € y −42,00 €. La cadena SIF siguió
verificada con cinco registros y la anulación aceptada continuó en posición 5,
sin aparecer un segundo registro de anulación. El operador comunicó la salida
de `sudo git -C /srv/apps/pastagansa rev-parse HEAD` como
`04160cdc2f82ffdfe7a2dd4c1ed4980f5d090ce5`, commit que incluye el flujo
`581e4b0`. En el momento de la captura, el SHA no se había verificado por SSH.
La captura no muestra el saldo pendiente; posteriormente, el operador confirmó
que la factura anulada indicaba `0,00 €`. Esa observación se registra como
declaración del operador, sin captura adicional. La actualización a cero y las
reversiones son atómicas según el código y las pruebas de integración.

Una consulta SSH de solo lectura posterior confirmó que
`git -C /srv/apps/pastagansa rev-parse HEAD` devolvía el SHA comunicado. No
se pudo ejecutar el ensayo de restauración desde esta sesión porque Docker
requiere `sudo` interactivo en ese host. El operador lo ejecutó posteriormente
y confirmó que terminó con `Restore drill passed`. Se registra como declaración
del operador; no constan en esta acta la ruta del dump, el log ni los recuentos
remotos.

El XML congelado de la posición 5 se verificó como se describe arriba.

## Rectificativa R4 por diferencias en pruebas

El 18/09/2026, la captura de staging mostró el alta de la rectificativa de prueba
`R2026-0001` como **aceptada** por AEAT pruebas, con CSV visible, posición SIF 6
y cadena local verificada con seis registros. El registro identifica como factura
rectificada `F2026-0003`. La trazabilidad mostró el asiento #5 equilibrado por
12,10 € y el apunte de IVA con base −10,00 € y cuota −2,10 €.

Se inspeccionó el XML descargado en
`/Users/alberto/Downloads/sif-6-registration.xml` (SHA-256 del archivo:
`a77ce1d458dabb788575309f58a7270cd95aa55cab9fbc71e55b56a8e82e050c`).
Incluye `TipoFactura=R4`, `TipoRectificativa=I`, referencia a `F2026-0003`,
base −10,00 €, cuota −2,10 € e importe total −12,10 €. Validó con el XSD local
`SuministroLR.xsd`; la huella propia coincidió con el SHA-256 recalculado de sus
campos canónicos y la huella de `RegistroAnterior` coincidió con la del XML de
la posición 5. La referencia a la factura rectificada y el encadenamiento al
registro anterior cumplen funciones distintas. Una consulta SSH de solo lectura
volvió a confirmar `04160cdc2f82ffdfe7a2dd4c1ed4980f5d090ce5` como HEAD de
staging. El XML no se copia al repositorio por contener identificadores fiscales.

La respuesta consta por la interfaz capturada; no se ha cotejado el SOAP ni el
CSV directamente en la sede de la AEAT. Una captura posterior mostró la
rectificativa `R2026-0001` emitida y con 0,00 € pendientes, y la factura original
`F2026-0003` en estado **Rectificada** y con 0,00 € pendientes. El botón de
recordatorio de pago que aparece en la original está deshabilitado por saldo
cero según la condición de la interfaz. La aceptación técnica de un ensayo R4
no acredita que el motivo elegido corresponda a R4 en una operación real; la
[AEAT distingue las causas R1 y R4](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html).

## F1 con fecha de operación y rectificativa R1 en pruebas

El 18/09/2026, el operador confirmó `565883ed3d7fe66130217bda00d98051065f9b3a`
desplegado en staging y comunicó que las altas de `F2026-0004` (posición 7) y
`R2026-0002` (posición 8) figuran **Aceptado**, ambas con CSV. Los valores CSV
y las respuestas SOAP no se facilitaron ni se cotejaron directamente con la
AEAT; esta parte del resultado consta como declaración del operador.

Se inspeccionaron los XML descargados en el Mac del operador. El alta F1
`/Users/alberto/Downloads/sif-7-registration.xml` tiene SHA-256 de archivo
`e5743293f118c7f09fc2160bef51e15804ad441bc56f101aec2a2f956bf62f74`.
Incluye fecha de emisión `18-09-2026`, `FechaOperacion=15-09-2026`, base
233,00 €, cuota 48,93 € e importe 281,93 €. Coincide con el PDF descargado
`factura-F2026-0004-1.pdf`, cuyo SHA-256 de archivo es
`768c9df21b6c4f6dadab840b6635e2d0fdbeab9bfbb56dbf3c993eab3ebec1c4`.

El alta R1 `/Users/alberto/Downloads/sif-8-registration.xml` tiene SHA-256
de archivo `c69c2859563213b9f2f20d89dbe09b5c2750d23eeb24bd5bf56baa71bddc452f`.
Incluye `TipoRectificativa=I`, referencia a `F2026-0004`, la misma
`FechaOperacion=15-09-2026`, base −233,00 €, cuota −48,93 € e importe
−281,93 €. Ambos XML validaron con el XSD local `SuministroLR.xsd`; las
huellas propias coincidieron con el SHA-256 recalculado y cada
`RegistroAnterior` enlazó con el XML previo disponible (posiciones 6 y 7).
Esto verifica los archivos y el encadenamiento disponible, no sustituye la
respuesta oficial de la AEAT ni la revisión del motivo fiscal.

El operador confirmó además que `F2026-0004` quedó **Rectificada** y con
**0,00 € pendientes** tras emitir `R2026-0002`. Esta observación de interfaz
no se ha comprobado de forma independiente en la base de datos.

El PDF F1 desplegado mostraba un solapamiento del QR con las fechas. El
ajuste visual se publicó en `5e87a36`; su PDF de muestra se inspeccionó y una
prueba comprueba la separación vertical. El operador confirmó el resultado
después de actualizar staging. Se inspeccionó el PDF redescargado
`/Users/alberto/Downloads/factura-F2026-0004-2.pdf` (SHA-256 de archivo
`9a59e8762fe0366b613dbe38852682657fa06e43265c8711e59ec11ae967fb54`):
una página A4, fecha de operación `15/09/2026`, vencimiento `02/10/2026` y
QR debajo de ambas fechas, sin solapamiento visual. En la extracción de
posiciones del PDF, el vencimiento termina en `y=174,325` y la etiqueta QR
comienza en `y=192`. No se obtuvo un SHA del nuevo HEAD de staging para esta
comprobación; el archivo redescargado sí muestra la disposición corregida.

Referencias: [preguntas frecuentes de la AEAT sobre factura emitida por error](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html),
[anulación de registros de facturación](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/registros-facturacion-anulacion.html)
y [descripción del servicio web](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf).

## Recuperación de remisiones inciertas en staging

El 18/09/2026 se confirmó por SSH de solo lectura que el checkout de staging
apuntaba a `56de778a1c4bfdefc1d4f85d447afb2734fe1bd6`, que incorpora el
reintento del XML congelado y la conciliación de altas duplicadas por huella e
`IdPeticion`. La ruta local `/acceso` y la URL pública respondieron HTTP 200;
una petición sin sesión a la API respondió 401, lo que confirma que era
alcanzable. No se pudo inspeccionar Docker directamente con este acceso porque
requiere `sudo` interactivo, por lo que el SHA del checkout no acredita por sí
solo el digest de las imágenes en ejecución.

El operador ejecutó en el PostgreSQL de staging una consulta agregada sobre
`sif_aeat_submissions` y comunicó: `ACCEPTED=6`,
`ACCEPTED_WITH_ERRORS=1`, `REJECTED=1`. No aparecieron filas `UNKNOWN` ni
`RETRY`. Esta observación demuestra que no había remisiones inciertas pendientes
en ese momento; **no constituye una prueba real de recuperación frente a la
AEAT**. La ruta de timeout, lease caducado, reenvío idéntico y duplicado
coincidente/no coincidente quedó cubierta por pruebas automatizadas. El workflow
[CI #35341071096](https://github.com/CoralDataLab/pastagansa/actions/runs/35341071096)
pasó migración, pruebas, aceptación de navegador, imágenes y restore drill.

Tras desplegar la vista de seguimiento, el 18/09/2026 la captura aportada por
el operador mostró en **Configuración → Remisiones AEAT Pruebas** los mismos
recuentos: 6 aceptados, 1 aceptado con errores, 1 rechazado y 0 en cola,
inciertos o fallidos. La pantalla indicó que no había envíos pendientes de
seguimiento. Una consulta SSH de solo lectura confirmó el checkout en
`a91f8ba521ee724401fe3ab47f70d028f930fcd7`; la web local y pública
respondieron HTTP 200 y una ruta de API sin sesión respondió 401. No se
inspeccionaron los healthchecks de Docker ni el digest de las imágenes por la
restricción de `sudo` interactivo, y no se provocó una remisión incierta real.

Tras desplegar la clasificación de incidencias, una nueva captura del operador
del 18/09/2026 mostró **2 de 2 resultados con incidencias**: el alta de la
posición 2 aceptada con errores enlazada con la subsanación aceptada de la
posición 4, y el alta rechazada de la posición 1 enlazada con la anulación
aceptada de la posición 5. Los recuentos permanecían en 6 aceptados, 1
aceptado con errores, 1 rechazado y 0 en cola, inciertos o fallidos. Una
consulta SSH de solo lectura confirmó el checkout
`6fc6171cbac179fccb2327a49976370ba6aeb416` y la URL pública `/acceso`
respondió HTTP 200. La captura verifica la presentación y el enlace de los
seguimientos; no es una nueva respuesta de AEAT ni acredita que las dos
incidencias históricas estén fiscalmente resueltas. No se cotejaron el digest
de las imágenes ni los healthchecks de Docker.

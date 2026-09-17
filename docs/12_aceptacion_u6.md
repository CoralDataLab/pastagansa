# Aceptación y operación U6

## Estado del gate

El 17/09/2026 el candidato U6A/U6B superó la validación local. El usuario desplegó
`2093c97` en el staging HTTPS y [Staging acceptance #35203960073](https://github.com/alberto-coraldatalab/pastagansa/actions/runs/35203960073)
pasó 3/3 con `E2E_SMTP_RECIPIENT` configurado. Se observaron los tres correos en el
buzón controlado y se abrieron sus PDF. **U6-08 sigue abierto:** el recordatorio
recibido decía «venció el sin fecha de vencimiento». La causa era que Cartera usaba el
plazo pendiente y la plantilla leía solo la fecha de vencimiento de la factura. La
corrección local usa el primer plazo sin cobrar y bloquea los avisos de vencida antes
de la fecha real; necesita desplegarse y repetir el gate remoto. También falta
completar el acta de la prueba moderada y los registros de restore drill.

| Comprobación local | Resultado |
| --- | --- |
| Lint y build de API/web | Correctos |
| Unitarias API/web | 81/81 y 39/39 tras la corrección del recordatorio |
| Integración PostgreSQL | 5/5 |
| Chromium, accesibilidad, perfil, snapshots, Cartera y cobro | 3/3 |
| SMTP capturado: presupuesto, factura y recordatorio con PDF | 3/3; adjuntos comparados visualmente con descargas |
| Seed demo repetido | `created: 0`, `existing: 11` en la segunda ejecución |
| Auditoría npm (`--audit-level=high`) | 0 vulnerabilidades |
| Imágenes aisladas y recorridos contra el stack local | Construidas; 3/3 E2E |
| Backup y restauración aislada | 43 migraciones y recuentos `1:1:1:1:1` iguales |
| Inspección visual PDF local | Factura A4 de una página y otra de cuatro páginas, todas renderizadas; sin recortes ni solapamientos observados |

La prueba de navegador usa `pdftoppm` para comparar todas las páginas renderizadas de
factura y presupuesto antes y después de cambiar el perfil de empresa. En CI usa un
servidor SMTP local que captura el PDF de presupuesto, factura y recordatorio y compara
su representación con la descarga del navegador. La misma suite prueba el camino sin
SMTP cuando no se configura correo.

## Cierre en staging publicado

1. Anotar SHA y URL HTTPS del candidato; comprobar que el host sigue siendo el staging
   aislado. Crear un backup **antes** de actualizar y conservarlo fuera del host según
   la política de retención.
2. Desplegar ese SHA con `./scripts/staging-up.sh`; ejecutar `./scripts/seed-demo.sh`
   dos veces y exigir `created: 0`, `existing: 11` en la segunda pasada.
3. Crear un backup nuevo y ejecutar `./scripts/restore-drill.sh RUTA_DEL_DUMP`.
   Registrar número de migraciones y recuentos.
4. Ejecutar **Staging acceptance** sobre la URL HTTPS con
   `E2E_SMTP_RECIPIENT` apuntando a un buzón controlado. Exigir 3/3 pruebas y cero
   infracciones graves de accesibilidad. El destinatario real se configura como
   secreto del entorno, nunca en el repositorio.
5. Abrir el buzón y confirmar las tres entregas (presupuesto, factura y recordatorio),
   remitente, destinatario, PDF adjunto y estado `SENT` en el historial. Comparar los
   adjuntos con las descargas del mismo documento.
6. Revisar visualmente una factura y un presupuesto de una página y sus variantes de
   varias páginas. Registrar cualquier recorte, solapamiento o problema de contraste.
7. Ejecutar la prueba moderada U6 con una persona administrativa distinta del autor.
   Registrar fecha, SHA, tareas, ayudas e incidencias. No cerrar con incidencias
   críticas o altas abiertas.

Evidencia reunida hasta ahora. Las confirmaciones del usuario se consignan como
declaraciones de la sesión, sin atribuirles comprobaciones automatizadas o registros
que no se han visto. Falta el acta con participante, tiempos, ayudas y comprobaciones
concretas antes de dar la prueba moderada por cerrada.

| Evidencia remota | Resultado / enlace |
| --- | --- |
| SHA, URL y fecha de despliegue | Usuario confirma `2093c97` en `https://ledger.coraldatalab.com` el 17/09/2026; build, API, web, PostgreSQL y healthchecks correctos |
| Backup previo y restore drill posterior | Usuario confirma backup previo y restauración correcta; faltan ruta/registro y recuentos remotos |
| Workflow E2E/WCAG HTTPS | [Staging acceptance #35203960073](https://github.com/alberto-coraldatalab/pastagansa/actions/runs/35203960073): 3/3 sobre `2093c97` con destinatario obligatorio; repetir tras el arreglo del recordatorio |
| Buzón controlado y adjuntos | Verificados en Proton Mail el 17/09/2026 a las 11:14–11:15: presupuesto `P2026-0001`, factura `FE2E-0001` y recordatorio de esa factura; tres PDF adjuntos; presupuesto y factura previsualizados con total 121,00 €; el PDF del recordatorio también se abre |
| Inspección PDF una/varias páginas | Previsualizados los tres adjuntos de una página en el buzón; inspección remota de variantes multipágina pendiente |
| Prueba moderada y clasificación de hallazgos | Usuario comunica «Todo OK sin problema»; pendiente acta con participante administrativo independiente, tareas, tiempos y ayudas; incidencia alta posterior en texto del recordatorio, corregida localmente y pendiente de despliegue |

La suite local tras la corrección pasó 3/3 en Chromium con SMTP de captura y compara
los PDF recibidos con las descargas. El E2E ahora comprueba además el estado `SENT`
del recordatorio y usa una factura realmente vencida, sin adelantar artificialmente
la fecha de referencia de Cartera.

## Correo y cola bloqueada

Guardar `.env.staging` con permisos `0600`, fuera de Git, y limitar el acceso al host.
Para rotar SMTP: cambiar la credencial en el proveedor y en ese archivo durante una
ventana controlada, recrear API con `./scripts/staging-up.sh`, enviar un documento de
prueba al buzón controlado y confirmar `SENT`. Rotar `JWT_SECRET` revoca las sesiones;
coordinarlo con los usuarios. Rotar contraseñas de PostgreSQL exige actualizar también
el rol y ambas URL de conexión antes de reiniciar.

Vigilar `/v1/health/ready`, `GET /v1/metrics` desde la red interna, logs del API y
estados/antigüedad de `document_deliveries`. Alertar si hay entregas `FAILED`, si
`PENDING` no disminuye después de dos ciclos de worker, o si `PROCESSING` supera el
lease de 15 minutos. El worker reintenta hasta cinco veces con espera creciente.

Si la cola se bloquea, comprobar primero salud de PostgreSQL, configuración y
conectividad SMTP, y logs correlacionados por request ID. Confirmar con el proveedor si
un mensaje llegó antes de iniciar una entrega nueva: un fallo posterior a la aceptación
SMTP puede dejar un resultado ambiguo. Conservar los registros `SENT`/`FAILED` y sus
eventos; no editar directamente la tabla ni borrar la cola. Tras reparar el proveedor,
seguir el historial del documento y usar una nueva acción de envío solo cuando se haya
descartado una entrega anterior. La emisión y descarga de PDF siguen disponibles sin
SMTP.

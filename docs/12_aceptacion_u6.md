# Aceptación y operación U6

## Estado del gate

El 17/09/2026 el candidato U6A/U6B superó la validación local y la suite remota
E2E/WCAG pasó sobre el staging HTTPS. El usuario confirma que desplegó `c80a752`,
realizó una prueba de restauración, recibió tres correos con PDF en un buzón controlado y
completó la prueba manual sin incidencias. **U6-08 sigue abierto** porque la suite
remota verde se ejecutó desde `e1b4b62`, no desde el SHA desplegado confirmado, y
`E2E_SMTP_RECIPIENT` estaba vacío: el envío automatizado se omitió. Falta repetir la
aceptación con el destinatario configurado sobre la versión final desplegada y
completar el acta de la prueba moderada.

| Comprobación local | Resultado |
| --- | --- |
| Lint y build de API/web | Correctos |
| Unitarias API/web | 78/78 y 39/39 |
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
| SHA, URL y fecha de despliegue | Usuario confirma `c80a752` en `https://ledger.coraldatalab.com` el 17/09/2026; imagen no verificada desde el host |
| Backup previo y restore drill posterior | Usuario confirma restauración correcta; faltan evidencia del backup previo, ruta/registro y recuentos remotos |
| Workflow E2E/WCAG HTTPS | [Staging acceptance #35199672024](https://github.com/alberto-coraldatalab/pastagansa/actions/runs/35199672024): 3/3 sobre `e1b4b62`, correcto el 17/09/2026; destinatario SMTP vacío, envío omitido; repetir sobre SHA final desplegado |
| Buzón controlado y adjuntos | Usuario confirma recepción manual de presupuesto, factura y recordatorio con PDF; faltan identificación del buzón y estados `SENT` documentados |
| Inspección PDF una/varias páginas | Pendiente |
| Prueba moderada y clasificación de hallazgos | Usuario comunica «Todo OK sin problema»; pendiente acta con participante administrativo independiente, tareas, tiempos, ayudas y hallazgos |

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

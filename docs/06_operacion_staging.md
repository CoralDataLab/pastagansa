# Operación de staging

Este entorno ejecuta PostgreSQL 17, la API NestJS y la web Next.js desde imágenes
construidas a partir del mismo commit. Solo la web publica un puerto en loopback; un
proxy con TLS debe ser el único punto expuesto fuera de la máquina.

## Preparación

Requisitos del host:

- Docker Engine con Compose v2;
- `curl` para el smoke test;
- espacio persistente y monitorizado para el volumen de PostgreSQL y los backups;
- un proxy HTTPS delante de `127.0.0.1:3101` para cualquier acceso remoto.

Crear el archivo de secretos, que está ignorado por Git:

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging
```

Sustituir todos los valores `replace-with`. Las contraseñas incluidas en las dos URL
de PostgreSQL deben coincidir con `POSTGRES_ADMIN_PASSWORD` y
`POSTGRES_APP_PASSWORD`; si contienen caracteres reservados de una URL deben
codificarse. Generar `JWT_SECRET` con al menos 32 caracteres aleatorios.

SMTP es opcional. Sin proveedor, la web desactiva el envío y ofrece la descarga PDF.
No se deben inventar valores SMTP para staging. Para habilitar entrega por correo y
recordatorios, añadir al `.env.staging` privado los datos reales del proveedor:

```dotenv
SMTP_HOST=smtp.proveedor.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario-smtp
SMTP_PASSWORD=secreto-del-proveedor
SMTP_FROM=Facturación <facturacion@tu-dominio.example>
```

Usar `SMTP_SECURE=true` normalmente solo con el puerto 465; con STARTTLS en el 587
debe ser `false`. `SMTP_HOST` y `SMTP_FROM` se configuran siempre juntos, y si se
indica `SMTP_USER` también es obligatorio `SMTP_PASSWORD`. Tras guardar el archivo,
desplegar de nuevo para recrear la API con esas variables. Las credenciales no se
imprimen ni se añaden al repositorio.

El staging aislado usa `THROTTLE_LIMIT=1000` para que los recorridos de aceptación
completos no compartan y agoten la ventana por IP. Producción conserva el límite normal
de 120 salvo una decisión operativa explícita.

## Pruebas de remisión VERI*FACTU a la AEAT

La integración solo apunta al servicio **de pruebas** de la AEAT y está desactivada
por defecto. Para activarla se necesita un certificado electrónico cualificado y
vigente con clave privada, en formato `.p12` o `.pfx`, del obligado tributario o de
un representante/apoderado o colaborador social autorizado para presentarlo. El NIF
de la empresa configurada en la aplicación debe ser el del obligado tributario real;
un NIF inventado no sirve para una prueba de remisión. El certificado usado para
autenticarse puede pertenecer al representante autorizado, de modo que no tiene por
qué coincidir con el NIF emisor. La AEAT valida ambos. No se debe enviar el archivo
ni su contraseña por chat, correo o al repositorio.

En el host de staging, guardar el certificado **fuera del checkout**, por ejemplo
en `/srv/pastagansa-secrets/aeat/staging/client.p12`. Guardar su contraseña exacta
en un segundo archivo privado, sin salto de línea final, por ejemplo
`/srv/pastagansa-secrets/aeat/staging/client.passphrase`. Ninguno de los dos debe
estar en Git, en la imagen Docker ni en un directorio público o sincronizado.
En `cassandra`, el operador `albecor` pertenece al grupo `1001`. Restringir el
directorio a `0750` y ambos archivos a `0640`, con propietario y grupo `albecor`.
El archivo adicional de Compose agrega ese grupo al proceso de la API para que
pueda leer los dos archivos sin cambiar el usuario `node` de la imagen. En otro
host, verificar el grupo y el mapeo de UID/GID antes de ajustar permisos.
A partir del certificado ya copiado, el operador puede crear el archivo de
contraseña sin mostrarla ni guardarla en el historial del shell:

```bash
read -r -s -p 'Contraseña del .p12: ' aeat_passphrase
printf '\n'
(umask 027; printf '%s' "$aeat_passphrase" > /srv/pastagansa-secrets/aeat/staging/client.passphrase)
unset aeat_passphrase
chmod 0640 /srv/pastagansa-secrets/aeat/staging/client.p12 \
  /srv/pastagansa-secrets/aeat/staging/client.passphrase
```

Añadir al `.env.staging` privado (permisos `600`) solo rutas y el GID:

```dotenv
AEAT_TEST_ENABLED=true
AEAT_TEST_PFX_HOST_PATH=/srv/pastagansa-secrets/aeat/staging/client-modern.p12
AEAT_TEST_PFX_PATH=/run/secrets/aeat-test.p12
AEAT_TEST_PFX_PASSPHRASE_HOST_PATH=/srv/pastagansa-secrets/aeat/staging/client.passphrase
AEAT_TEST_PFX_PASSPHRASE_FILE=/run/secrets/aeat-test-passphrase
AEAT_TEST_SECRET_GID=1001
```

Crear y verificar un backup antes del cambio. El archivo adicional de Compose
monta ambos secretos en la API en modo de solo lectura y falla si falta alguno.
Antes de arrancar el servicio, comprobar solo su legibilidad, sin mostrar contenido:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml \
  -f docker-compose.aeat-test.yml run --rm --no-deps --entrypoint sh api \
  -c 'test -r /run/secrets/aeat-test.p12 && test -r /run/secrets/aeat-test-passphrase'
```

Después desplegar:

```bash
./scripts/staging-up.sh .env.staging docker-compose.aeat-test.yml
```

La API valida al arrancar que el `.p12` puede abrirse con la contraseña. Un
healthcheck verde confirma acceso local al certificado, pero no prueba todavía
que la AEAT reconozca el certificado o la autorización del NIF emisor; eso exige
un envío controlado posterior al entorno de pruebas.

En `cassandra`, el archivo entregado inicialmente se abría solo con la opción
`-legacy` de OpenSSL 3. Se conservó intacto como `client.p12` y se creó
`client-modern.p12` con cifrado AES-256-CBC y MAC SHA-256. Se comprobó que
ambos contienen el mismo certificado; la configuración debe apuntar a la copia
moderna. No exportar la clave privada descifrada a un archivo ordinario durante
una renovación del certificado.

El servicio solo envía XML congelado de facturas y anulaciones emitidas con modo
`VERIFACTU` y entorno `TEST`. Para la primera prueba, usar una empresa española
autorizada **sin registros SIF previos**; cambiar una cadena existente de modo
requiere revisión. La API encola el envío de forma transaccional, respeta la espera
indicada por la AEAT y conserva el estado, CSV, error y respuesta por registro en
`GET /v1/sif/records/{recordId}/test-submissions` (permiso `sif_record.read`).
`ACCEPTED` y `ACCEPTED_WITH_ERRORS` son respuestas registradas; `REJECTED` exige
corregir el registro conforme a la respuesta de la AEAT. `UNKNOWN` indica que la
petición pudo llegar sin respuesta verificable. El worker reenvía automáticamente
**el mismo XML congelado** tras una espera creciente (máximo una hora), sin crear
otro registro SIF ni otra huella. Si la AEAT responde «duplicado» para un alta,
consulta el registro previo y solo lo marca aceptado cuando coinciden NIF,
número, fecha, huella y `IdPeticion`. Conserva la respuesta de esa consulta en
`reconciliation_xml`; el CSV del primer envío no se puede recuperar por consulta.
Un duplicado no verificable, una anulación duplicada o una respuesta ambigua
mantienen `UNKNOWN` y bloquean los registros posteriores de la cadena hasta
obtener una respuesta definitiva o revisión administrativa. `RETRY` cubre fallos
temporales y también se reintenta con espera creciente. `FAILED` indica un fallo
local anterior al envío, que requiere revisión. Antes de un reenvío manual,
consultar los intentos y lo recibido en la AEAT.
Referencia: [FAQ oficial de reenvío sin respuesta](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/sistemas-verifactu.html)
y [descripción oficial del servicio de consulta y duplicados](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf).

Para desactivar los envíos nuevos, poner `AEAT_TEST_ENABLED=false` y desplegar sin
el archivo adicional de Compose. La configuración de producción mantiene el
remitente AEAT de pruebas desactivado por diseño.

## Recuperación de una contraseña sin SMTP

Generar el enlace temporal desde el host, sustituyendo el correo y la URL pública:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml exec api \
  node apps/api/scripts/create-password-reset.mjs usuario@empresa.es https://ledger.example.com
```

El comando imprime un enlace válido durante 30 minutos. Solo debe compartirse con el
propietario de la cuenta mediante un canal privado. Generar otro enlace invalida el
anterior; al elegir la contraseña nueva se consume el token y se revocan todas las
sesiones que tuviera abiertas. El token se almacena únicamente como SHA-256 y nunca se
debe copiar a logs, tickets o canales compartidos. La duración puede configurarse entre
5 y 1440 minutos mediante `PASSWORD_RESET_TTL_MINUTES` al ejecutar el comando.

## Despliegue y actualización

Desde el commit que se quiere desplegar:

```bash
./scripts/staging-up.sh
```

El comando construye las dos imágenes, espera PostgreSQL, aplica todas las migraciones
pendientes antes de arrancar la API, espera los healthchecks y comprueba `/acceso`.
Una actualización usa el mismo comando. Las migraciones son forward-only; antes de una
actualización con cambios de esquema se debe crear y verificar un backup.

En un entorno destinado a evaluación, cargar o verificar los datos demo con:

```bash
./scripts/seed-demo.sh
```

El seed es idempotente y se ejecuta dentro de la red privada del stack. Sus credenciales
y el recorrido guiado están en [Probar el producto](07_probar_producto.md).

Cuando el proxy HTTPS esté publicado, ejecutar los recorridos reales contra esa URL
desde GitHub Actions mediante **Staging acceptance**, o localmente:

```bash
E2E_BASE_URL=https://staging.example.com \
E2E_ALLOW_REMOTE_WRITE=1 \
npm run test:staging
```

Si SMTP está activo, para encolar una entrega real durante el recorrido de venta hay
que añadir `E2E_SMTP_RECIPIENT=buzon-controlado@tu-dominio.example`. El destinatario
debe ser un buzón controlado y, al terminar, se debe comprobar manualmente que el PDF
recibido coincide con el descargado por el navegador. Sin esa variable, la prueba
cubre de forma segura tanto la interfaz con SMTP disponible como la alternativa de
descarga cuando no lo está, pero no envía ningún correo.

La confirmación `E2E_ALLOW_REMOTE_WRITE=1` es obligatoria porque la prueba crea dos
organizaciones y documentos ficticios. Solo debe apuntar a un staging aislado, nunca a
producción. El guion de evaluación humana está en
[Prueba moderada](08_prueba_moderada.md).

Comprobaciones operativas:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml ps
docker compose --env-file .env.staging -f docker-compose.staging.yml logs --tail=200 api web
curl --fail http://127.0.0.1:3101/acceso
```

La API no publica puertos al host. Su healthcheck usa `/v1/health/ready`, que consulta
la tabla `users` con el rol de runtime; así detecta tanto una caída de PostgreSQL como
permisos incompletos en un volumen existente. Los logs JSON de la API incluyen el
request ID; las respuestas devuelven `x-request-id` para correlación.

## Backup y ensayo de restauración

Crear un dump en formato custom con permisos `0600`:

```bash
backup_file="$(./scripts/backup-database.sh)"
echo "$backup_file"
```

El directorio `backups/` está ignorado por Git. Hay que copiar los dumps a un destino
cifrado fuera del host y aplicar una política de retención.

Ensayar el backup sin modificar la base activa:

```bash
./scripts/restore-drill.sh "$backup_file"
```

El ensayo crea `pastagansa_restore_drill`, restaura el dump, compara el número de
migraciones aplicadas, comprueba tablas críticas y elimina siempre esa base temporal.
Debe ejecutarse después de cada cambio de esquema y periódicamente en staging.

## Restauración real

Una restauración real es destructiva y requiere una ventana de mantenimiento:

1. confirmar el archivo, fecha, tamaño y ubicación externa del dump;
2. detener `web` y `api`, manteniendo `postgres` activo;
3. crear primero una copia final de la base dañada para análisis;
4. recrear la base `pastagansa` con propietario `pastagansa_admin`;
5. ejecutar `pg_restore --exit-on-error --no-owner --no-acl`;
6. reaplicar los grants del rol `pastagansa_app` y ejecutar `prisma migrate deploy`;
7. arrancar API/web y completar healthcheck más los dos recorridos E2E.

No automatizamos esos pasos destructivos para evitar que un error de ruta o entorno
sobrescriba la base activa. El `restore-drill` es el mecanismo automatizado seguro.

## Parada y rollback

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml down
```

`down` conserva el volumen. No usar `down -v` en staging. Para volver al código anterior,
cambiar al commit conocido, reconstruir con `staging-up.sh` y verificar compatibilidad de
su binario con el esquema ya migrado. Si no es compatible, restaurar el backup mediante
el procedimiento de mantenimiento anterior.

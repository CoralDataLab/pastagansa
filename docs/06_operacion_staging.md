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

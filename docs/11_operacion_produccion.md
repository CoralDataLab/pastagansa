# Operación de producción (instancia independiente)

Este perfil está pensado para una VM Linux distinta de staging. Usa el proyecto
Compose `pastagansa-production` y el volumen exclusivo
`pastagansa-production-postgres-data`. PostgreSQL y la API no publican puertos;
solo la web escucha en `127.0.0.1:3101` para un proxy HTTPS externo. La imagen
de API de producción no contiene `seed-demo.mjs`.

**No copiar la base de datos ni los volúmenes de staging.** No ejecutar
`seed-demo.sh`, `test:staging` ni el workflow **Staging acceptance** contra
producción: generan datos ficticios. Los ocho registros SIF experimentales de
CORALDATALAB, S.L. deben permanecer en la instancia de pruebas.

## Antes de la primera instalación

- Preparar VM, firewall y un dominio HTTPS distinto al de staging. El proxy debe
  ser el único punto público y dirigirse a `127.0.0.1:3101`.
- Instalar Docker Engine con Compose v2, `curl` y `git`; reservar almacenamiento
  persistente para PostgreSQL y espacio suficiente para copias temporales.
- Preparar un destino externo cifrado para backups y una política de retención.
  Los scripts de este repositorio generan y ensayan dumps locales, pero **no**
  los cifran ni los transfieren fuera de la VM. Esa tarea operativa debe quedar
  resuelta antes de facturar realmente.
- Desplegar un commit con CI verde y comprobar que la versión de código coincide
  en la VM. No cargar datos demo ni importar registros históricos de staging.

Crear las credenciales privadas (distintas de staging):

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Editar `.env.production` sin versionarlo. Sustituir todos los `replace-with` de
líneas activas. Las contraseñas de PostgreSQL de las URL deben coincidir con
`POSTGRES_ADMIN_PASSWORD` y `POSTGRES_APP_PASSWORD`; usar caracteres seguros
para URL o codificar los reservados. `JWT_SECRET` debe tener al menos 32
caracteres aleatorios. El archivo solo puede tener permisos `0600` o `0400`.
No reutilizar ningún secreto de staging. La configuración usa variables de
entorno dentro de Compose: quienes administran Docker pueden leerlas, por lo
que el acceso a Docker y al host debe estar restringido. Los scripts de producción
ignoran variables de Compose exportadas en la shell y leen sus valores desde
`.env.production` para evitar que valores de staging anulen la configuración.

## Primera instalación

```bash
./scripts/production-up.sh init
```

El comando rechaza un volumen de producción ya existente, valida el archivo
de entorno, construye las imágenes, aplica migraciones y espera los
healthchecks. Comprueba que organizaciones, empresas, usuarios, facturas,
registros SIF, asientos y libro fiscal están vacíos. Si falla, **no** borrar el
volumen automáticamente: investigar el estado antes de reintentar. Solo
después se registra la empresa real y se verifica su configuración fiscal.

Antes de la primera factura real: comprobar HTTPS, usuario/empresa correctos,
serie y numeración, PDF, `DISABLED` como modo SIF transitorio, base sin datos
de prueba, envío de backups cifrados fuera de la VM y ensayo de restauración.
La puesta en marcha técnica no equivale a una certificación fiscal del producto.

## Backup, restauración de ensayo y actualizaciones

```bash
backup_file="$(./scripts/production-backup.sh)"
./scripts/production-restore-drill.sh "$backup_file"
```

El dump local se crea con permisos `0600` en `backups/production/`, ignorado
por Git. El ensayo restaura en una base temporal con nombre propio, compara
migraciones y recuentos de tablas críticas, y elimina **solo esa base temporal**.
No reemplaza la base activa. Copiar el dump de forma cifrada al destino externo,
verificar su integridad y probar periódicamente una restauración desde allí.
La copia local no es suficiente contra pérdida de la VM.

Para actualizar una producción ya iniciada:

```bash
./scripts/production-up.sh upgrade
```

Exige que el volumen y PostgreSQL de producción existan, crea un backup nuevo,
realiza el ensayo de restauración y solo entonces reconstruye/recrea el stack.
Programar una ventana sin nuevas operaciones de facturación: el ensayo compara
recuentos del backup con la base activa y rechazará diferencias si se escriben
datos durante la comprobación.
El backup local y su ruta se muestran al operador; conservar además una copia
externa cifrada. Las migraciones son *forward-only*: volver a un commit anterior
sin comprobar compatibilidad de esquema no es un plan de rollback.

## Comprobaciones operativas

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps
curl --fail http://127.0.0.1:3101/acceso
```

La API dispone de `/v1/health/ready` dentro de su contenedor. Revisar
periódicamente salud, espacio del volumen, expiración TLS, alertas, logs,
ejecución y restaurabilidad de backups. Nunca lanzar los E2E remotos contra
producción: crean organizaciones y facturas de prueba.

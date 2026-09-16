# PastaGansa

ERP SaaS para facturación, compras, contabilidad y fiscalidad española. El repositorio
contiene el API NestJS y la aplicación web Next.js en un monorepo npm.

## Probarlo en local

Requisitos: Node.js 22 o posterior y Docker.

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d postgres
npm install
npm run db:generate
npm run db:deploy
npm run dev
```

Abre `http://localhost:3001`, crea una cuenta y la aplicación te llevará a la empresa
creada. El API queda en `http://localhost:3000`, con OpenAPI en
`http://localhost:3000/docs`.

Para entrar directamente con una empresa y maestros demo, deja API y web arrancadas y
ejecuta:

```bash
npm run demo:seed
```

Después inicia sesión en `http://localhost:3001/acceso` con
`demo@pastagansa.local` / `DemoPastagansa2026!`. El comando se puede repetir: reutiliza
los mismos datos y no duplica recursos. Consulta [la guía para probar el producto](docs/07_probar_producto.md)
para el recorrido y el reinicio seguro.

## Verificación

```bash
npm run lint
npm run build
npm test
npm run test:integration
```

Las pruebas de integración requieren PostgreSQL y todas las migraciones aplicadas.
Consulta [la guía del API](apps/api/README.md) para el detalle funcional y
[el plan de producto usable](docs/05_plan_producto_usable.md) para el orden activo de
entrega.

## Staging y recuperación

El repositorio incluye imágenes de producción para API/web y un stack reproducible con
PostgreSQL, migraciones automáticas y healthchecks:

```bash
cp .env.staging.example .env.staging
# Sustituye todos los valores replace-with
./scripts/staging-up.sh
./scripts/seed-demo.sh
backup_file="$(./scripts/backup-database.sh)"
./scripts/restore-drill.sh "$backup_file"
```

Consulta [la guía de operación](docs/06_operacion_staging.md) antes de exponer el
entorno, actualizar el esquema o restaurar datos. Una vez publicado con HTTPS, el
workflow manual **Staging acceptance** ejecuta los dos recorridos y las auditorías de
accesibilidad contra la URL real.

## Producción independiente

La configuración de producción usa un proyecto Compose, volumen PostgreSQL y archivo
de secretos distintos. No se arranca con los scripts de staging ni se importa su base
de datos. Consulta [la guía de producción](docs/11_operacion_produccion.md) para la
primera instalación, actualizaciones con backup y ensayo de restauración. El proxy
HTTPS y los backups cifrados fuera de la VM son requisitos operativos pendientes de
configurar en la nueva instancia antes de emitir facturas reales.

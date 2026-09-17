# Probar el producto

## Datos demo

Con API y web locales arrancadas, crear el dataset determinista:

```bash
npm run demo:seed
```

En el stack de staging local:

```bash
./scripts/staging-up.sh
./scripts/seed-demo.sh
```

El seed utiliza por defecto estas credenciales, exclusivas para desarrollo y demos:

- usuario: `demo@pastagansa.local`;
- contraseña: `DemoPastagansa2026!`.

Crea la empresa `PastaGansa Demo SL`, un cliente, un proveedor, un servicio a 75 €/h,
series de venta, compra y presupuestos, una cuenta bancaria ligada a la cuenta
contable 572000, un perfil documental con logo pequeño, una factura emitida con
vencimiento y una promesa de pago en su cronología. Una segunda ejecución reutiliza
los once recursos y debe informar `created: 0` y `existing: 11`.

Para personalizar credenciales se pueden definir `DEMO_EMAIL` y `DEMO_PASSWORD`. El
script rechaza hosts que no sean loopback; sembrar un entorno demo remoto exige además
`ALLOW_REMOTE_DEMO_SEED=1`. No usar estos datos ni credenciales en producción.

## Recorrido breve de venta

1. Abrir `http://localhost:3001/acceso` (o el puerto 3101 del stack) e iniciar sesión.
2. Entrar en **Clientes** y comprobar que existe `Cliente Demo SL`.
3. Entrar en **Catálogo** y comprobar el servicio `DEMO-SERVICIO`.
4. Crear una factura con ese cliente y servicio, emitirla con `DEMO-F` y descargar el
   PDF.
5. Registrar el cobro y comprobar el nuevo estado en factura, inicio y diario.

## Recorrido breve de compra

1. Crear una compra para `Proveedor Demo SA` y seleccionar la serie `DEMO-C`.
2. Adjuntar un PNG o JPEG, solicitar OCR y revisar el resultado; un PDF se admite como
   adjunto pero no se ofrece para OCR.
3. Aprobar la compra, registrar su pago y comprobar inicio, diario y mayor.

## Reiniciar una demo local

El seed es idempotente pero no borra documentos creados durante una prueba. Para una
demo totalmente limpia hay que destruir únicamente el volumen del stack local y
recrearlo:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml down -v
./scripts/staging-up.sh
./scripts/seed-demo.sh
```

`down -v` elimina toda la base del stack seleccionado y no se debe ejecutar en un
staging compartido. En un entorno compartido se conserva la base o se restaura un
backup verificado siguiendo la guía de operación.

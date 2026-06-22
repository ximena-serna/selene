# Control de Ahorros — Guía de instalación

Esta app reemplaza tus Excels de control de pagos. Funciona desde el celular, calcula
multas automáticamente (misma lógica que ya validamos en el Excel: semana ancla en
lunes por cliente, $X/día de atraso sin tope), y permite registrar pagos a partir de
una foto de comprobante o un mensaje de texto — siempre con tu confirmación antes de
guardar nada.

## 1. Subir la app a Netlify

1. Ve a [app.netlify.com](https://app.netlify.com) → "Add new site" → "Deploy manually"
2. Arrastra esta carpeta completa (o un .zip de ella)
3. Netlify te da una URL tipo `tuapp.netlify.app` — esa es la que vas a usar tú y la dueña

## 2. Configurar la API key de Claude (para la lectura de comprobantes)

La app usa una función intermedia (`netlify/functions/claude-proxy.js`) para que tu
API key nunca quede visible en el navegador. Necesitas:

1. Consigue una API key en [console.anthropic.com](https://console.anthropic.com) → API Keys
2. En Netlify: tu sitio → **Site configuration → Environment variables**
3. Agrega una variable: `ANTHROPIC_API_KEY` = tu clave
4. Vuelve a desplegar el sitio (Netlify → Deploys → "Trigger deploy") para que tome la variable

**Nota de costo:** cada lectura de comprobante (foto o texto) hace una llamada a la
API de Claude, que tiene un costo muy bajo por uso (centavos de dólar por lectura).
No es gratis indefinidamente, pero para el volumen de un negocio como este el costo
mensual es mínimo.

## 3. Configurar las reglas de seguridad de Firestore

1. En la consola de Firebase de tu proyecto (`control-ahorros-fb`) → Firestore Database → Reglas
2. Copia el contenido de `firestore.rules` (incluido en esta carpeta) y pégalo ahí
3. Publica

Esto asegura que solo tú y la dueña (con sesión iniciada) puedan ver o modificar los datos.

## 4. Crear los usuarios que pueden entrar

1. Firebase Console → Authentication → Users → "Add user"
2. Agrega:
   - `xysa11092007@gmail.com` (tú) con una contraseña que elijas
   - `cp.andrea.mtz@hotmail.com` (la dueña) con una contraseña que elijas
3. Comparte la contraseña con la dueña por un medio seguro (no por el mismo chat donde manda capturas, idealmente)

## 5. Cargar tus grupos y clientes existentes

La app empieza vacía. Desde la pantalla principal:
- Botón "+" → crear cada grupo (nombre, plazo en semanas, multa por día)
- Dentro de cada grupo → "+ Agregar cliente" para cada persona (nombre, producto, total)
- Los pagos históricos que ya tienes en tus Excels los puedes ir registrando con
  "Registrar pago" eligiendo la fecha real de cada uno (no tiene que ser hoy)

Si quieres, en vez de capturar los 28+ clientes uno por uno desde el celular, puedo
ayudarte a hacer una carga masiva inicial — solo pásame los datos de cada grupo
(nombre, producto, total por cliente) en una lista o tabla y los subo todos de una vez.

## Cómo funciona la lectura de comprobantes

1. Tocas "Registrar pago" → eliges "Captura" (foto) o "Mensaje" (texto de Messenger)
2. La IA propone monto y fecha
3. **Tú siempre ves esos datos en un formulario editable antes de guardar** — si algo
   se leyó mal, lo corriges ahí mismo
4. Solo al tocar "Confirmar y guardar pago" se registra de verdad

Este paso de confirmación es la diferencia clave con tu intento anterior: la IA nunca
guarda nada por su cuenta.

// Lectura de comprobantes con IA — SIEMPRE devuelve una PROPUESTA editable.
// Nunca guarda nada por sí sola; quien confirma es la persona usando la app.
// Esto es justo lo que falló en el intento anterior: ahí no había paso de revisión.

async function callClaude(messages) {
  // Llama al proxy seguro (Netlify Function) en vez de a la API directo —
  // así la API key nunca queda expuesta en el navegador.
  const response = await fetch("/.netlify/functions/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: 1000, messages })
  });
  if (!response.ok) throw new Error("No se pudo leer el comprobante (error de conexión).");
  const data = await response.json();
  const textBlock = data.content?.find(b => b.type === "text");
  if (!textBlock) throw new Error("La IA no devolvió texto legible.");
  return textBlock.text;
}

function parseJsonLoose(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No se encontró un resultado interpretable.");
  return JSON.parse(clean.slice(start, end + 1));
}

const SYSTEM_INSTRUCTIONS = `Eres un asistente que extrae datos de comprobantes de pago para un negocio mexicano de ventas por Facebook con grupos de "ahorro" (pagos semanales por productos).
Tu única tarea es proponer datos — NUNCA confirmes ni asumas que el pago es válido, solo extrae lo que ves.
Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloques de código markdown, con esta forma exacta:
{
  "monto": <número sin comas ni signos, ej. 1150, o null si no estás segura>,
  "fecha": "<YYYY-MM-DD o null>",
  "hora": "<HH:MM en formato 24h, ej. 14:32, o null>",
  "cuenta": "<banco y últimos 4 dígitos si aparecen, ej. BBVA 1234, BANAMEX 3294, OXXO, efectivo, o null>",
  "nombreDetectado": "<nombre del remitente si aparece en el comprobante, o null>",
  "esAnticipo": <true si el concepto dice anticipo/apartado/seña, false en caso contrario>,
  "numeroPago": <número entero si el concepto o referencia indica qué pago es (ej. "pago 3"), o null>,
  "confianza": "<alta|media|baja>",
  "notas": "<cualquier ambigüedad que la persona deba revisar, en español, muy breve>"
}
Reglas importantes:
- Para la HORA: busca la hora de la transacción en el comprobante (no la hora de generación del PDF). Formato 24h.
- Para la CUENTA: extrae el banco y los últimos 4 dígitos de la cuenta/tarjeta destino, ej. "BBVA 3294".
- Para el MONTO: solo el número, sin "$", sin comas. Si ves "$1,150.00" extrae 1150.
- Para la FECHA: usa la fecha de la transacción, formato YYYY-MM-DD.
- Si el texto es algo como "ya te pagué 200" sin imagen: monto=200, hora=null, cuenta=null, fecha=null, confianza="media".
- Si la imagen está borrosa o no es un comprobante claro: confianza="baja" y explica en notas.
- NUNCA inventes datos que no estén visibles en el comprobante.`;

/**
 * Lee un comprobante de pago a partir de una imagen en base64.
 * @returns {Promise<object>} propuesta con monto, fecha, etc. — para REVISAR, no para guardar directo.
 */
export async function leerComprobanteImagen(base64Data, mediaType) {
  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
      { type: "text", text: SYSTEM_INSTRUCTIONS }
    ]
  }];
  const text = await callClaude(messages);
  return parseJsonLoose(text);
}

/**
 * Lee un pago a partir de texto libre (ej. mensaje de Messenger pegado).
 */
export async function leerComprobanteTexto(textoMensaje) {
  const messages = [{
    role: "user",
    content: `${SYSTEM_INSTRUCTIONS}\n\nMensaje a interpretar: "${textoMensaje}"`
  }];
  const text = await callClaude(messages);
  return parseJsonLoose(text);
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

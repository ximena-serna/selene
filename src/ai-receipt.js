// Lectura de comprobantes con IA — SIEMPRE devuelve una PROPUESTA editable.
// Nunca guarda nada por sí sola; quien confirma es la persona usando la app.

async function callClaude(messages) {
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
Responde ÚNICAMENTE con un objeto JSON, sin texto antes ni después, con esta forma exacta:
{
  "monto": <número o null si no estás segura>,
  "fecha": "<YYYY-MM-DD o null>",
  "nombreDetectado": "<nombre si aparece en el comprobante, o null>",
  "banco": "<banco/app detectado, ej. BBVA, Banamex, OXXO, efectivo, o null>",
  "confianza": "<alta|media|baja>",
  "notas": "<cualquier ambigüedad que la persona deba revisar, en español, breve>"
}
Si la imagen está borrosa, recortada, o no es claramente un comprobante, baja la confianza y dilo en "notas".
Si el texto es algo como "ya te pagué 200" sin más contexto, usa monto=200, fecha=null (asume hoy en notas), confianza="media".
NUNCA inventes un monto o nombre que no esté explícito.`;

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

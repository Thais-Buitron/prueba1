/* =====================================================================
   GuideLight · IA (Cloudflare Pages Functions)
   ---------------------------------------------------------------------
   Va en el repositorio, en la carpeta functions/api/ con el nombre ia.js.
   Cloudflare Pages lo publica en la dirección /api/ia de tu página.
   Necesita un enlace (binding) de Workers AI llamado AI, que se agrega en
   Cloudflare: proyecto → Settings → Bindings → Add → Workers AI.
   ===================================================================== */

/* Modelo de IA. El grande responde mejor; el pequeño gasta mucho menos de la
   cuota gratuita diaria. Si la cuota no alcanza, cambia a la segunda línea. */
const MODELO = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// const MODELO = "@cf/meta/llama-3.1-8b-instruct";

const INSTRUCCIONES = `Eres GuideLight, el asistente del COAR Lima Provincias (Perú), creado por el equipo TechWorld. Ayudas a estudiantes de 3.º a 5.º de secundaria que viven en la residencia del colegio y llevan el Diploma del Bachillerato Internacional (IB).

Cómo responder:
- Responde en el idioma del estudiante (normalmente español), de tú, con un tono cercano y claro. Sin emojis.
- Sé breve: máximo 120 palabras. Usa listas con guiones cuando enumeres pasos.
- Para cualquier dato del COAR (fechas, horarios, normas, clubes, eventos, personas, enlaces) usa SOLO la información del CONTEXTO. Si el dato no está, dilo con honestidad («Todavía no tengo ese dato») y sugiere preguntar al tutor o tutora. Nunca inventes fechas, horarios, nombres, normas ni enlaces.
- Usa el glosario del CONTEXTO para entender las siglas del colegio (por ejemplo, TEMP es Tecnología para el Emprendimiento).
- Puedes dar consejos generales de estudio, organización, bienestar y sobre el Diploma IB.
- No pidas datos personales. No compartas contraseñas, notas ni información de otras personas.
- Si el estudiante dice que quiere hacerse daño o que está en peligro, responde con empatía, dile que busque ahora a un adulto de confianza o al equipo de bienestar del COAR, y que puede llamar gratis a la Línea 113, opción 5 (salud mental), o al 106 (SAMU) si es una emergencia.
- Si la pregunta no tiene que ver con la vida escolar, responde con amabilidad que solo ayudas con temas del COAR y del colegio.`;

const responder = (cuerpo, estado = 200) => Response.json(cuerpo, { status: estado });

export async function onRequestPost({ request, env }) {
  // Solo acepta preguntas que vienen de la misma página de GuideLight
  const origen = request.headers.get("Origin");
  if (origen && origen !== new URL(request.url).origin) return responder({ error: "Esta página no tiene permiso" }, 403);
  if (!env.AI) return responder({ error: "Falta el enlace de Workers AI llamado AI" }, 500);

  let datos;
  try { datos = await request.json(); } catch { return responder({ error: "Datos inválidos" }, 400); }

  const pregunta = String(datos.pregunta || "").trim().slice(0, 500);
  const contexto = String(datos.contexto || "").slice(0, 16000);
  if (!pregunta) return responder({ error: "Falta la pregunta" }, 400);

  const historial = (Array.isArray(datos.historial) ? datos.historial : [])
    .slice(-8)
    .filter((h) => h && (h.rol === "user" || h.rol === "assistant") && typeof h.texto === "string")
    .map((h) => ({ role: h.rol, content: h.texto.slice(0, 600) }));

  try {
    const resultado = await env.AI.run(MODELO, {
      messages: [
        { role: "system", content: INSTRUCCIONES + "\n\nCONTEXTO:\n" + contexto },
        ...historial,
        { role: "user", content: pregunta }
      ],
      max_tokens: 400,
      temperature: 0.3
    });
    const respuesta = String(resultado && resultado.response || "").trim();
    if (!respuesta) return responder({ error: "La IA no devolvió respuesta" }, 502);
    return responder({ respuesta });
  } catch (e) {
    // Por ejemplo, cuando se acaba la cuota gratuita del día. La página responde sola.
    return responder({ error: "La IA no está disponible ahora" }, 503);
  }
}

/* =====================================================================
   GuideLight · Citador APA (Cloudflare Pages Functions)
   ---------------------------------------------------------------------
   Va en el repositorio, en la carpeta functions/api/ con el nombre cita.js.
   Cloudflare lo publica en la dirección /api/cita de la página.

   Recibe lo que el estudiante pegó (un link, un DOI, un ISBN o datos sueltos)
   y devuelve los datos de la fuente para armar la referencia APA:
   - DOI  → Crossref (datos oficiales del artículo o libro)
   - ISBN → Open Library
   - Link → lee la página (metadatos del autor, fecha, título y sitio);
            YouTube → título y canal
   - Texto suelto o datos incompletos → la IA (Workers AI, enlace "AI")
     ordena los datos, sin inventar nada.
   La página arma la referencia con las reglas APA; aquí solo se buscan datos.
   ===================================================================== */

const MODELO = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const UA = "Mozilla/5.0 (compatible; GuideLightCitas/1.0; +https://prueba1-5l1.pages.dev)";
const responder = (cuerpo, estado = 200) => Response.json(cuerpo, { status: estado });

export async function onRequestPost({ request, env }) {
  const origen = request.headers.get("Origin");
  if (origen && origen !== new URL(request.url).origin) return responder({ error: "Esta página no tiene permiso" }, 403);
  let datos;
  try { datos = await request.json(); } catch { return responder({ error: "Datos inválidos" }, 400); }
  const entrada = String(datos.entrada || "").trim().slice(0, 4000);
  if (!entrada) return responder({ error: "Falta la fuente" }, 400);
  try {
    return responder(await buscarFuente(entrada, env));
  } catch (e) {
    return responder({ error: "No se pudo leer la fuente" }, 502);
  }
}

async function buscarFuente(entrada, env = {}, pedir = fetch) {
  const avisos = [];
  const doi = buscarDOI(entrada);
  const isbn = buscarISBN(entrada);
  const url = (entrada.match(/https?:\/\/[^\s"'<>]+/i) || [])[0];

  if (doi) {
    const c = await crossref(doi, pedir);
    if (c) return { campos: c, origen: "crossref", avisos };
  }
  if (isbn) {
    const l = await openLibrary(isbn, pedir);
    if (l) return { campos: l, origen: "openlibrary", avisos };
  }
  if (url) {
    let campos = null;
    if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(dominio(url))) campos = await youtube(url, pedir);
    let html = "";
    try { html = await leerPagina(url, pedir); } catch (e) { /* la página no deja leerse */ }
    if (!campos && html) campos = extraerDePagina(html, url);
    if (campos && campos.doi && campos.tipo !== "video") {
      const c = await crossref(campos.doi, pedir);
      if (c) return { campos: c, origen: "crossref", avisos };
    }
    if (campos && campos.tipo === "video" && html && !campos.anio) Object.assign(campos, fechaDe(metaUno(leerMetas(html), ["uploaddate", "datepublished"])));
    if (!campos) {
      campos = { tipo: "web", autores: [], titulo: null, sitio: sitioDesdeDominio(url), url };
      avisos.push("No pudimos leer la página. Completa el título, el autor y la fecha.");
    }
    // la IA completa lo que falte, usando el texto de la página
    if (env.AI && html && (!campos.autores.length || !campos.anio || !campos.titulo)) {
      const ia = await iaExtraer(env, `Página web: ${url}\nTítulo: ${campos.titulo || ""}\nTexto de la página:\n${textoVisible(html).slice(0, 3500)}`);
      if (ia) completar(campos, ia, avisos);
    }
    return { campos, origen: "web", avisos };
  }
  // texto suelto: la IA ordena los datos
  if (env.AI) {
    const ia = await iaExtraer(env, entrada);
    if (ia && ia.titulo) return { campos: normalizar(ia), origen: "ia", avisos: ["Revisa los datos: la IA los ordenó a partir de lo que escribiste."] };
  }
  return { campos: null, origen: "ninguno", avisos: ["Pega el link, el DOI o el ISBN de tu fuente, o completa los datos a mano."] };
}

/* ---------- Detectores ---------- */
function buscarDOI(t) {
  const m = String(t).match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[).,;\]]+$/, "") : null;
}
function buscarISBN(t) {
  const s = String(t).trim();
  const limpio = s.replace(/[\s-]/g, "");
  if (/isbn/i.test(s) || /^(97[89]\d{10}|\d{9}[\dXx])$/.test(limpio)) {
    const m = s.replace(/isbn(-1[03])?:?/ig, "").replace(/[\s-]/g, "").match(/97[89]\d{10}|\d{9}[\dXx]/);
    return m ? m[0].toUpperCase() : null;
  }
  return null;
}
const dominio = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function sitioDesdeDominio(u) { return dominio(u) || null; }

/* ---------- Crossref (DOI) ---------- */
async function crossref(doi, pedir) {
  try {
    const r = await pedir(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return desdeCrossref((await r.json()).message);
  } catch { return null; }
}
function desdeCrossref(m) {
  if (!m) return null;
  const partes = ((m.issued || m["published-print"] || m["published-online"] || {})["date-parts"] || [[]])[0] || [];
  const tipo = /book-chapter|book-part/.test(m.type) ? "capitulo" : /book|monograph|edited-book|reference-book/.test(m.type) ? "libro" : /journal-article|proceedings-article/.test(m.type) ? "articulo" : "web";
  return {
    tipo,
    autores: (m.author || m.editor || []).map((a) => a.family ? { apellido: a.family, nombre: a.given || "" } : { organizacion: a.name || "" }).filter((a) => a.apellido || a.organizacion),
    anio: partes[0] ? String(partes[0]) : null, mes: partes[1] || null, dia: partes[2] || null,
    titulo: limpiarTexto((m.title || [])[0] || "") + ((m.subtitle || [])[0] ? ": " + limpiarTexto(m.subtitle[0]) : ""),
    revista: tipo === "articulo" ? limpiarTexto((m["container-title"] || [])[0] || "") || null : null,
    libro: tipo === "capitulo" ? limpiarTexto((m["container-title"] || [])[0] || "") || null : null,
    volumen: m.volume || null, numero: m.issue || null, paginas: m.page ? m.page.replace(/-/g, "–") : null,
    editorial: tipo === "libro" || tipo === "capitulo" ? m.publisher || null : null,
    doi: m.DOI || null, url: null, sitio: null
  };
}

/* ---------- Open Library (ISBN) ---------- */
async function openLibrary(isbn, pedir) {
  try {
    const r = await pedir(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return desdeOpenLibrary((await r.json())[`ISBN:${isbn}`]);
  } catch { return null; }
}
function desdeOpenLibrary(b) {
  if (!b || !b.title) return null;
  return {
    tipo: "libro",
    autores: (b.authors || []).map((a) => nombreDesdeTexto(a.name)).filter(Boolean),
    anio: ((b.publish_date || "").match(/\d{4}/) || [null])[0],
    titulo: b.title + (b.subtitle ? ": " + b.subtitle : ""),
    editorial: ((b.publishers || [])[0] || {}).name || null,
    url: null, doi: null, sitio: null
  };
}

/* ---------- YouTube ---------- */
async function youtube(url, pedir) {
  try {
    const r = await pedir(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const o = await r.json();
    return { tipo: "video", autores: o.author_name ? [{ organizacion: o.author_name }] : [], titulo: o.title || null, sitio: "YouTube", url, anio: null };
  } catch { return null; }
}

/* ---------- Páginas web ---------- */
async function leerPagina(url, pedir) {
  const r = await pedir(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(9000) });
  if (!r.ok || !/html/i.test(r.headers.get("content-type") || "html")) return "";
  const texto = await r.text();
  return texto.slice(0, 1500000);
}
function leerMetas(html) {
  const metas = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const clave = (tag.match(/\b(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const valor = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (!clave || valor === undefined) continue;
    const k = clave.toLowerCase();
    (metas[k] = metas[k] || []).push(decodificar(valor).trim());
  }
  return metas;
}
const metaUno = (metas, claves) => { for (const k of claves) if (metas[k] && metas[k][0]) return metas[k][0]; return null; };
function jsonLD(html) {
  const objs = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1].trim());
      const pila = Array.isArray(d) ? d : [d];
      while (pila.length) { const o = pila.shift(); if (!o || typeof o !== "object") continue; objs.push(o); if (o["@graph"]) pila.push(...o["@graph"]); }
    } catch { /* JSON roto */ }
  }
  return objs.find((o) => o.headline || /Article|NewsArticle|BlogPosting|Report|WebPage/.test([].concat(o["@type"] || []).join(" "))) || null;
}
function extraerDePagina(html, url) {
  const metas = leerMetas(html), ld = jsonLD(html);
  const tituloHTML = decodificar((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s+/g, " ").trim();
  const sitio = metaUno(metas, ["og:site_name", "application-name", "citation_publisher", "dc.publisher"]) || (ld && ld.publisher && ld.publisher.name) || sitioDesdeDominio(url);
  let titulo = metaUno(metas, ["citation_title", "dc.title", "og:title", "twitter:title"]) || (ld && ld.headline) || tituloHTML || null;
  if (titulo && sitio) titulo = titulo.replace(new RegExp(`\\s*[|·–—-]\\s*${escRegex(sitio)}\\s*$`, "i"), "").trim();
  if (titulo && !metaUno(metas, ["citation_title", "og:title"])) titulo = titulo.replace(/\s+[|·–—]\s+[^|·–—]{2,40}$/, "").trim();
  let autores = (metas["citation_author"] || metas["dc.creator"] || []).map(nombreDesdeTexto).filter(Boolean);
  if (!autores.length) {
    const la = ld && ld.author ? [].concat(ld.author).map((a) => typeof a === "string" ? a : a && a.name).filter(Boolean) : [];
    const ma = [metaUno(metas, ["author", "article:author", "parsely-author", "sailthru.author", "byl"])].filter((a) => a && !/^https?:/i.test(a));
    autores = (la.length ? la : ma).flatMap((a) => String(a).replace(/^por\s+/i, "").split(/\s*(?:,| y | and |&)\s*(?=[A-ZÁÉÍÓÚÑ])/)).map(nombreDesdeTexto).filter(Boolean);
  }
  const fecha = fechaDe(metaUno(metas, ["citation_publication_date", "citation_date", "citation_online_date", "dc.date", "article:published_time", "datepublished", "date", "pubdate", "publish-date", "parsely-pub-date", "sailthru.date"]) || (ld && ld.datePublished));
  const revista = metaUno(metas, ["citation_journal_title"]);
  const inicio = metaUno(metas, ["citation_firstpage"]), fin = metaUno(metas, ["citation_lastpage"]);
  const doi = buscarDOI(metaUno(metas, ["citation_doi", "dc.identifier", "prism.doi"]) || "");
  const tipo = revista ? "articulo" : /book/i.test(metaUno(metas, ["og:type"]) || "") ? "libro" : "web";
  return {
    tipo, autores, titulo, sitio: tipo === "web" ? sitio : null, revista,
    volumen: metaUno(metas, ["citation_volume"]), numero: metaUno(metas, ["citation_issue"]),
    paginas: inicio ? (fin ? `${inicio}–${fin}` : inicio) : null,
    editorial: tipo === "libro" ? sitio : null, doi, url, ...fecha
  };
}
function fechaDe(t) {
  if (!t) return { anio: null };
  const s = String(t);
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return { anio: m[1], mes: +m[2], dia: +m[3] };
  m = s.match(/(\d{4})[-/.](\d{1,2})\b/);
  if (m) return { anio: m[1], mes: +m[2] };
  m = s.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return { anio: m ? m[1] : null };
}
function nombreDesdeTexto(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  if (!s || s.length > 80 || /^https?:/i.test(s)) return null;
  if (s.includes(",")) { const [ap, no] = s.split(",", 2); return { apellido: ap.trim(), nombre: (no || "").trim() }; }
  const p = s.split(" ");
  if (p.length === 1 || /\b(redacci[oó]n|equipo|ministerio|universidad|instituto|organizaci[oó]n|agencia|colegio|coar|editorial|asociaci[oó]n)\b/i.test(s)) return { organizacion: s };
  if (p.length === 2) return { apellido: p[1], nombre: p[0] };
  if (p.length === 3) return { apellido: p.slice(1).join(" "), nombre: p[0] };
  return { apellido: p.slice(-2).join(" "), nombre: p.slice(0, -2).join(" ") };
}
function textoVisible(html) {
  return decodificar(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function decodificar(s) {
  return String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const limpiarTexto = (s) => decodificar(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const escRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ---------- IA: ordena datos sueltos sin inventar ---------- */
const PROMPT_IA = `Extrae los datos bibliográficos de la fuente descrita. Responde SOLO con un objeto JSON, sin texto antes ni después, con estas claves:
{"tipo":"web|articulo|libro|video","autores":[{"apellido":"","nombre":""} o {"organizacion":""}],"anio":"","mes":null,"dia":null,"titulo":"","sitio":"","revista":"","volumen":"","numero":"","paginas":"","editorial":"","url":"","doi":""}
Reglas: usa null (o [] en autores) cuando un dato NO aparece. Nunca inventes autores, fechas, páginas ni editoriales. Copia el título tal como aparece. mes y dia son números.`;
async function iaExtraer(env, texto) {
  try {
    const r = await env.AI.run(MODELO, { messages: [{ role: "system", content: PROMPT_IA }, { role: "user", content: texto.slice(0, 4000) }], max_tokens: 500, temperature: 0 });
    const m = String(r && r.response || "").match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}
function normalizar(o) {
  const v = (x) => (x === undefined || x === "" || x === "null") ? null : x;
  return {
    tipo: ["web", "articulo", "libro", "video"].includes(o.tipo) ? o.tipo : "web",
    autores: Array.isArray(o.autores) ? o.autores.filter((a) => a && (a.apellido || a.organizacion)) : [],
    anio: v(o.anio) ? String(o.anio).match(/\d{4}/)?.[0] || null : null, mes: v(o.mes) ? +o.mes || null : null, dia: v(o.dia) ? +o.dia || null : null,
    titulo: v(o.titulo), sitio: v(o.sitio), revista: v(o.revista), volumen: v(o.volumen), numero: v(o.numero), paginas: v(o.paginas),
    editorial: v(o.editorial), url: v(o.url), doi: v(o.doi)
  };
}
function completar(campos, ia, avisos) {
  const n = normalizar(ia);
  if (!campos.autores.length && n.autores.length) { campos.autores = n.autores; avisos.push("El autor lo encontró la IA en el texto de la página: revísalo."); }
  if (!campos.anio && n.anio) { campos.anio = n.anio; campos.mes = n.mes; campos.dia = n.dia; avisos.push("La fecha la encontró la IA en el texto de la página: revísala."); }
  if (!campos.titulo && n.titulo) campos.titulo = n.titulo;
}

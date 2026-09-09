/* =========================================================================
   VIVI · Backend clínico para la Guía HJ23 / iNurse
   -------------------------------------------------------------------------
   - Proxy hacia Gemini (para no exponer la API key en el móvil)
   - Búsqueda en repositorios médicos reales: Europe PMC, PubMed, openFDA
   - Endpoint de "respuesta con evidencia": busca en Internet + sintetiza
     con Gemini en el estilo de Vivi (voz, SBART, sin markdown)
   - Control de luces Philips Hue (bridge local, API CLIP v2)

   Sin dependencias externas. Requiere Node 18 o superior (fetch nativo).
   Ejecutar:   node server.js
   ========================================================================= */

'use strict';

const http = require('node:http');
const https = require('node:https');

/* --------------------------- Configuración --------------------------- */
const PORT          = process.env.PORT || 8080;
// Clave de Gemini del servidor. Si está puesta, se usa esta y el móvil NO
// necesita llevar la clave. Si no, se acepta la que mande el cliente.
const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Opcional: clave de NCBI para subir el límite de peticiones a PubMed.
const NCBI_KEY      = process.env.NCBI_API_KEY || '';
// Contacto recomendado por NCBI (buena educación con su API).
const NCBI_TOOL     = 'vivi-hj23';
const NCBI_EMAIL    = process.env.NCBI_EMAIL || '';

const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models';

// --- Philips Hue (bridge local, API CLIP v2) ---
// IP del bridge en tu red (la da https://discovery.meethue.com o la app Hue).
const HUE_BRIDGE_IP = process.env.HUE_BRIDGE_IP || '';
// Clave de aplicación: se consigue una sola vez con POST /api/hue/pair
// (pulsando antes el botón del bridge) y se guarda aquí.
const HUE_APP_KEY   = process.env.HUE_APP_KEY || '';
// Opcional pero recomendado si expones el servidor a Internet: un secreto
// compartido. Si está puesto, las rutas /api/hue/* exigen este token.
const HUE_TOKEN     = process.env.HUE_TOKEN || '';

/* ------------------------------ Utilidades ------------------------------ */

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // CORS abierto: la app puede llamarlo desde el móvil, desde file:// o
    // desde cualquier hosting.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) { // 25 MB (imágenes en base64)
        reject(new Error('Cuerpo de la petición demasiado grande'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('JSON no válido en la petición')); }
    });
    req.on('error', reject);
  });
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function clamp(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
}

async function fetchJSON(url, opts, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: r.ok, status: r.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

/* ======================================================================
   1) REPOSITORIOS MÉDICOS
   ====================================================================== */

/* ---- Europe PMC (literatura, con abstract en una sola llamada) ---- */
async function searchEuropePMC(query, limit = 5) {
  // Ordenamos por relevancia (sort vacío = relevancia en Europe PMC).
  // Restringimos a artículos con abstract para que la evidencia sea útil.
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
    + '?query=' + encodeURIComponent('(' + query + ') AND HAS_ABSTRACT:Y')
    + '&format=json&resultType=core&pageSize=' + limit;
  const { ok, json } = await fetchJSON(url);
  if (!ok || !json || !json.resultList) return [];
  const rows = json.resultList.result || [];
  return rows.map(r => {
    const pmid = r.pmid || '';
    const doi  = r.doi || '';
    let link = '';
    if (pmid) link = 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/';
    else if (doi) link = 'https://doi.org/' + doi;
    else if (r.id && r.source) link = 'https://europepmc.org/article/' + r.source + '/' + r.id;
    return {
      source: 'Europe PMC',
      title: stripTags(r.title),
      authors: r.authorString || '',
      journal: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || r.bookOrReportDetails || '',
      year: r.pubYear || '',
      pmid, doi, url: link,
      abstract: clamp(stripTags(r.abstractText), 1200)
    };
  });
}

/* ---- PubMed / NCBI E-utilities (autoridad; complementa Europe PMC) ---- */
function ncbiExtra() {
  let s = '&tool=' + NCBI_TOOL;
  if (NCBI_EMAIL) s += '&email=' + encodeURIComponent(NCBI_EMAIL);
  if (NCBI_KEY)   s += '&api_key=' + NCBI_KEY;
  return s;
}

async function searchPubMed(query, limit = 5) {
  // Paso 1: esearch → lista de PMIDs
  const esearch = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
    + '?db=pubmed&retmode=json&retmax=' + limit
    + '&sort=relevance&term=' + encodeURIComponent(query) + ncbiExtra();
  const s = await fetchJSON(esearch);
  const ids = (s.json && s.json.esearchresult && s.json.esearchresult.idlist) || [];
  if (!ids.length) return [];
  // Paso 2: esummary → metadatos
  const esummary = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'
    + '?db=pubmed&retmode=json&id=' + ids.join(',') + ncbiExtra();
  const sum = await fetchJSON(esummary);
  const result = (sum.json && sum.json.result) || {};
  return ids.map(id => {
    const r = result[id] || {};
    const authors = (r.authors || []).map(a => a.name).slice(0, 6).join(', ');
    const year = (r.pubdate || '').split(' ')[0] || '';
    const doi = (r.articleids || []).filter(a => a.idtype === 'doi').map(a => a.value)[0] || '';
    return {
      source: 'PubMed',
      title: stripTags(r.title),
      authors,
      journal: r.fulljournalname || r.source || '',
      year, pmid: id, doi,
      url: 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/',
      abstract: '' // esummary no trae abstract; Europe PMC lo cubre
    };
  });
}

/* ---- openFDA (fichas de fármacos) ---- */
async function searchOpenFDA(drug, limit = 1) {
  const q = 'openfda.generic_name:"' + drug + '"+openfda.brand_name:"' + drug + '"';
  const url = 'https://api.fda.gov/drug/label.json?search='
    + encodeURIComponent(q) + '&limit=' + limit;
  const { ok, json } = await fetchJSON(url);
  if (!ok || !json || !json.results) return [];
  return json.results.map(r => {
    const of = r.openfda || {};
    const name = (of.generic_name && of.generic_name[0])
      || (of.brand_name && of.brand_name[0]) || drug;
    const pick = (f) => Array.isArray(r[f]) ? clamp(r[f].join(' '), 800) : '';
    return {
      source: 'openFDA (ficha técnica)',
      title: 'Ficha de ' + name,
      drug: name,
      indications: pick('indications_and_usage'),
      dosage: pick('dosage_and_administration'),
      warnings: pick('warnings') || pick('boxed_warning'),
      contraindications: pick('contraindications'),
      adverse: pick('adverse_reactions'),
      url: 'https://www.accessdata.fda.gov/scripts/cder/daf/'
    };
  });
}

/* ---- Búsqueda combinada de literatura (dedupe por PMID/título) ---- */
async function searchLiterature(query, limit = 5) {
  const [epmc, pm] = await Promise.allSettled([
    searchEuropePMC(query, limit),
    searchPubMed(query, limit)
  ]);
  const a = epmc.status === 'fulfilled' ? epmc.value : [];
  const b = pm.status === 'fulfilled' ? pm.value : [];
  const seen = new Set();
  const out = [];
  // Europe PMC primero (trae abstract); rellenamos con PubMed lo que falte.
  for (const item of [...a, ...b]) {
    const key = item.pmid || (item.doi || '') || item.title.toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/* ======================================================================
   2) GEMINI
   ====================================================================== */

function resolveKey(bodyKey, req) {
  if (GEMINI_KEY) return GEMINI_KEY; // la del servidor manda
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bodyKey || bearer || '';
}

async function callGemini(key, model, payload) {
  const url = GEMINI_BASE + '/' + (model || GEMINI_MODEL)
    + ':generateContent?key=' + encodeURIComponent(key);
  const { ok, status, json } = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 45000);
  if (!ok) {
    const msg = (json && json.error && json.error.message) || ('Error Gemini ' + status);
    throw new Error(msg);
  }
  const c = json && json.candidates && json.candidates[0];
  const text = c && c.content && c.content.parts
    ? c.content.parts.map(p => p.text || '').join('').trim()
    : '';
  return { text: text || '(sin respuesta)', raw: json };
}

/* Traduce la consulta clínica (en español) a una búsqueda en INGLÉS para los
   repositorios médicos, que son mayoritariamente en inglés. Si falla, usa la
   consulta original. */
async function optimizeQuery(question, key) {
  if (!key) return question;
  try {
    const { text } = await callGemini(key, GEMINI_MODEL, {
      systemInstruction: { parts: [{ text:
        'Convierte la consulta clínica del usuario en una búsqueda para PubMed en INGLÉS. '
        + 'Devuelve SOLO de 3 a 7 palabras clave en inglés separadas por espacios, sin comillas, '
        + 'sin puntuación y sin ninguna explicación. Añade la palabra "nursing" solo si la consulta '
        + 'trata de cuidados de enfermería.' }] },
      contents: [{ role: 'user', parts: [{ text: question }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 120,
        // Desactivamos el "pensamiento" del modelo: para extraer palabras clave
        // no hace falta y, si no, se comía el presupuesto y devolvía vacío.
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    const q = (text || '').replace(/["'\n]/g, ' ').replace(/\s+/g, ' ').trim();
    return q.length >= 3 ? q : question;
  } catch (e) {
    return question;
  }
}

/* ======================================================================
   3) PHILIPS HUE (bridge local, API CLIP v2)
   ====================================================================== */

/* El bridge usa HTTPS con certificado autofirmado, así que hablamos con él
   mediante node:https aceptando ese certificado. Solo se usa para la IP
   local del bridge; el resto de peticiones del servidor siguen verificando
   los certificados con normalidad.
   Sin keep-alive: el bridge cierra la conexión tras cada respuesta y, si se
   intenta reutilizar (comportamiento por defecto de Node 19+), la segunda
   petición se queda colgada hasta agotar el tiempo de espera. */
const hueAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

function hueRequest(method, path, payload, appKey) {
  return new Promise((resolve, reject) => {
    if (!HUE_BRIDGE_IP) {
      return reject(httpErr(400, 'Falta HUE_BRIDGE_IP en el servidor (la IP del bridge en tu red).'));
    }
    const body = payload ? JSON.stringify(payload) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (appKey) headers['hue-application-key'] = appKey;
    const req = https.request({
      host: HUE_BRIDGE_IP,
      method,
      path,
      headers,
      agent: hueAgent,
      rejectUnauthorized: false, // certificado autofirmado del bridge
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { json = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('El bridge Hue no responde (¿está el servidor en la misma red?)')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requireHueKey() {
  if (!HUE_APP_KEY) {
    throw httpErr(400, 'Falta HUE_APP_KEY en el servidor. Pulsa el botón del bridge y llama a POST /api/hue/pair para conseguirla.');
  }
  return HUE_APP_KEY;
}

function checkHueToken(body, req) {
  if (!HUE_TOKEN) return;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if ((body.token || bearer) !== HUE_TOKEN) {
    throw httpErr(401, 'Token de Hue no válido.');
  }
}

/* Colores: aceptamos "#rrggbb" o nombres sencillos en español y los
   convertimos al espacio xy que usa Hue (conversión sRGB → CIE 1931). */
const HUE_COLORS = {
  rojo: '#ff0000', verde: '#00ff00', azul: '#0000ff', amarillo: '#ffdf00',
  naranja: '#ff7f00', rosa: '#ff69b4', morado: '#8000ff', violeta: '#8000ff',
  cian: '#00ffff', turquesa: '#40e0d0', blanco: '#ffffff',
  'blanco calido': '#ffd9a0', 'blanco cálido': '#ffd9a0', 'blanco frio': '#e6f0ff', 'blanco frío': '#e6f0ff'
};

function colorToXY(color) {
  let hex = String(color || '').trim().toLowerCase();
  if (HUE_COLORS[hex]) hex = HUE_COLORS[hex];
  const m = /^#?([0-9a-f]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const gam = c => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  const r = gam(((n >> 16) & 255) / 255);
  const g = gam(((n >> 8) & 255) / 255);
  const b = gam((n & 255) / 255);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const sum = X + Y + Z;
  if (!sum) return { x: 0.3127, y: 0.329 }; // negro → punto blanco neutro
  return { x: +(X / sum).toFixed(4), y: +(Y / sum).toFixed(4) };
}

/* Traduce los parámetros sencillos de la app (on, brightness, color) al
   cuerpo que espera la API v2 del bridge. */
function hueStateFromParams(body) {
  const out = {};
  if (typeof body.on === 'boolean') out.on = { on: body.on };
  const bri = parseFloat(body.brightness);
  if (!isNaN(bri)) {
    out.dimming = { brightness: Math.min(Math.max(bri, 0), 100) };
    if (!out.on && bri > 0) out.on = { on: true }; // subir brillo implica encender
  }
  if (body.color) {
    const xy = colorToXY(body.color);
    if (!xy) throw httpErr(400, 'Color no reconocido. Usa "#rrggbb" o un nombre como rojo, azul, blanco cálido…');
    out.color = { xy };
    if (!out.on) out.on = { on: true }; // cambiar color implica encender
  }
  if (!Object.keys(out).length) {
    throw httpErr(400, 'No hay nada que cambiar: manda "on" (true/false), "brightness" (0-100) y/o "color".');
  }
  return out;
}

async function hueListLights() {
  const key = requireHueKey();
  const { ok, status, json } = await hueRequest('GET', '/clip/v2/resource/light', null, key);
  if (!ok) throw httpErr(502, 'Error del bridge Hue (HTTP ' + status + ').');
  const rows = (json && json.data) || [];
  return rows.map(l => ({
    id: l.id,
    name: (l.metadata && l.metadata.name) || '(sin nombre)',
    on: !!(l.on && l.on.on),
    brightness: l.dimming ? l.dimming.brightness : null
  }));
}

/* Grupo "toda la casa" del bridge, para encender/apagar todo de una vez. */
async function hueBridgeHomeGroup() {
  const key = requireHueKey();
  const { ok, status, json } = await hueRequest('GET', '/clip/v2/resource/grouped_light', null, key);
  if (!ok) throw httpErr(502, 'Error del bridge Hue (HTTP ' + status + ').');
  const rows = (json && json.data) || [];
  const home = rows.find(g => g.owner && g.owner.rtype === 'bridge_home') || rows[0];
  if (!home) throw httpErr(404, 'El bridge no tiene grupos de luces.');
  return home.id;
}

/* ======================================================================
   4) RUTAS
   ====================================================================== */

const routes = {

  /* --- salud --- */
  'GET /api/health': async () => ({
    ok: true,
    service: 'vivi-backend',
    model: GEMINI_MODEL,
    gemini_key_server: !!GEMINI_KEY,
    repos: ['Europe PMC', 'PubMed', 'openFDA'],
    hue: {
      bridge_ip: !!HUE_BRIDGE_IP,
      app_key: !!HUE_APP_KEY,
      token: !!HUE_TOKEN
    },
    time: new Date().toISOString()
  }),

  /* --- proxy Gemini: mismo body que ya usa la app hoy ---
     Cambiando solo la URL de los 4 fetch de la app, todo sigue funcionando
     y la clave deja de viajar en el móvil (si la pones en el servidor).   */
  'POST /api/gemini': async (body, req) => {
    const key = resolveKey(body.apiKey || body.key, req);
    if (!key) throw httpErr(400, 'Falta la clave de Gemini (ponla en el servidor o mándala en apiKey).');
    const model = body.model || GEMINI_MODEL;
    // Aceptamos el payload tal cual (contents / systemInstruction / generationConfig)
    const payload = body.payload || {
      contents: body.contents,
      systemInstruction: body.systemInstruction,
      generationConfig: body.generationConfig
    };
    if (!payload.contents) throw httpErr(400, 'Falta "contents" en la petición.');
    const { text, raw } = await callGemini(key, model, payload);
    return { text, raw };
  },

  /* --- solo búsqueda en repositorios (sin IA) --- */
  'POST /api/repos/search': async (body) => {
    const query = (body.query || body.q || '').trim();
    if (!query) throw httpErr(400, 'Falta "query".');
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5, 1), 10);
    const results = await searchLiterature(query, limit);
    return { query, count: results.length, results };
  },

  /* --- ficha de fármaco (openFDA + resumen IA opcional) --- */
  'POST /api/drug': async (body, req) => {
    const name = (body.name || body.drug || '').trim();
    if (!name) throw httpErr(400, 'Falta "name".');
    const fda = await searchOpenFDA(name, 1);
    const key = resolveKey(body.apiKey || body.key, req);
    if (!key || body.summary === false) {
      return { drug: name, fda, summary: null };
    }
    const ficha = fda[0] || null;
    const sys = 'Eres Vivi, asistente clínica de enfermería (Hospital Universitari Joan XXIII). '
      + 'Resume la ficha del fármaco en español claro y natural, apto para leerse en voz alta, '
      + 'sin markdown ni asteriscos, con guiones simples. Estructura: indicaciones, dosis habitual '
      + 'para enfermería, precauciones y efectos adversos frecuentes. Si la ficha viene en inglés, tradúcela. '
      + 'Termina con: "Material orientativo. Prevalecen la ficha técnica local y el juicio del profesional."';
    const ctx = ficha ? JSON.stringify(ficha) : 'No hay ficha en openFDA para este fármaco.';
    const { text } = await callGemini(key, GEMINI_MODEL, {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: 'FÁRMACO: ' + name + '\n\nFICHA (openFDA):\n' + ctx }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 900 }
    });
    return { drug: name, fda, summary: text };
  },

  /* --- ESTRELLA: responder consultando Internet + guías locales ---
     El móvil manda la pregunta (y opcionalmente el contexto de sus guías
     locales). El backend busca en PubMed/Europe PMC, y Gemini sintetiza en
     el estilo de Vivi, citando las fuentes. */
  'POST /api/ask': async (body, req) => {
    const question = (body.question || body.q || '').trim();
    if (!question) throw httpErr(400, 'Falta "question".');
    const key = resolveKey(body.apiKey || body.key, req);
    if (!key) throw httpErr(400, 'Falta la clave de Gemini.');

    const localCtx = clamp(body.context || body.localContext || '', 12000);
    const wantSbart = body.sbart !== false; // por defecto, formato SBART
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 4, 1), 8);

    // 1) Buscar evidencia en repositorios (traduciendo antes a inglés)
    const searchTerm = body.searchTerm || await optimizeQuery(question, key);
    const sources = await searchLiterature(searchTerm, limit);

    // 2) Construir el bloque de evidencia numerado
    const evidence = sources.map((s, i) => {
      const cita = [s.authors, s.journal, s.year].filter(Boolean).join('. ');
      return `FUENTE ${i + 1} (${s.source}${s.pmid ? ', PMID ' + s.pmid : ''}):\n`
        + `Título: ${s.title}\n`
        + (cita ? `Referencia: ${cita}\n` : '')
        + (s.abstract ? `Resumen: ${s.abstract}\n` : '');
    }).join('\n');

    // 3) Prompt en el estilo de Vivi
    let sys = 'Eres Vivi, asistente de apoyo a la decisión para el personal de enfermería del '
      + 'Hospital Universitari Joan XXIII de Tarragona (turno de tarde). Respondes SIEMPRE en español, '
      + 'con tono claro, cercano y natural, pensado para escucharse por voz.\n'
      + 'Tienes DOS fuentes: (A) el CONTEXTO de las guías locales de la app, que es tu referencia '
      + 'principal, y (B) EVIDENCIA CIENTÍFICA RECIENTE recuperada de repositorios médicos (PubMed, '
      + 'Europe PMC). Integra ambas: prioriza la guía local y complétala o actualízala con la evidencia. '
      + 'Cuando uses un dato de la evidencia, cítalo diciendo (Fuente 1), (Fuente 2), etc.\n\n'
      + 'REGLAS DE ESTILO:\n'
      + '- Sin markdown, sin tablas, sin asteriscos ni símbolos raros (el sintetizador los lee mal). '
      + 'Usa saltos de línea y guiones simples para listar.\n'
      + '- Si un dato no está ni en la guía ni en la evidencia, dilo con amabilidad y no lo inventes.\n'
      + '- Si es una urgencia vital, recalca activar el protocolo local y avisar al equipo médico.\n';

    if (wantSbart) {
      sys += '\nCuando el usuario describa un caso o una sospecha clínica, estructura la respuesta con el '
        + 'modelo SBART:\n'
        + 'S - SITUACIÓN: el problema principal en una frase.\n'
        + 'B - ANTECEDENTES: contexto clínico relevante (criterios, clasificaciones de riesgo, fenotipos).\n'
        + 'A - EVALUACIÓN: qué valorar a pie de cama (constantes, signos de alarma, glucemia, monitorización).\n'
        + 'R - RECOMENDACIÓN: plan de enfermería paso a paso, qué preparar y cuándo avisar al médico.\n'
        + 'T - TRANSFERENCIA: monitorización posterior, destino del paciente, activación de códigos.\n';
    }

    sys += '\nTermina SIEMPRE con esta frase en una línea independiente: '
      + '"Apoyo a la decisión clínica basado en tus guías y en la evidencia consultada. '
      + 'Prevalecen el protocolo local y el juicio del profesional."';

    const userMsg =
      (localCtx ? '[CONTEXTO DE LAS GUÍAS HJ23 — fuente principal]\n' + localCtx + '\n[FIN DEL CONTEXTO]\n\n' : '')
      + (evidence ? '[EVIDENCIA RECUPERADA DE REPOSITORIOS MÉDICOS]\n' + evidence + '\n[FIN DE LA EVIDENCIA]\n\n' : '[No se ha recuperado evidencia externa para esta consulta.]\n\n')
      + 'PREGUNTA DEL PROFESIONAL: ' + question;

    const { text } = await callGemini(key, GEMINI_MODEL, {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: userMsg }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 1600 }
    });

    return {
      question,
      answer: text,
      sources: sources.map((s, i) => ({ n: i + 1, ...s }))
    };
  },

  /* ======================= PHILIPS HUE ======================= */

  /* --- emparejar con el bridge (una sola vez) ---
     1. Pulsa el botón redondo del bridge.
     2. Antes de 30 segundos: POST /api/hue/pair
     3. Guarda la clave devuelta en la variable de entorno HUE_APP_KEY. */
  'POST /api/hue/pair': async (body, req) => {
    checkHueToken(body, req);
    const { json } = await hueRequest('POST', '/api', {
      devicetype: 'vivi#backend',
      generateclientkey: true
    });
    const first = Array.isArray(json) ? json[0] : null;
    if (first && first.success && first.success.username) {
      return {
        ok: true,
        app_key: first.success.username,
        client_key: first.success.clientkey || null,
        siguiente_paso: 'Guarda app_key en la variable de entorno HUE_APP_KEY y reinicia el servidor.'
      };
    }
    const desc = (first && first.error && first.error.description) || 'respuesta inesperada del bridge';
    throw httpErr(400, 'No se pudo emparejar: ' + desc + '. ¿Has pulsado el botón del bridge?');
  },

  /* --- listar luces --- */
  'GET /api/hue/lights': async (body, req) => {
    checkHueToken(body, req);
    const lights = await hueListLights();
    return { count: lights.length, lights };
  },

  /* --- controlar una luz o todas ---
     body: { id?, on?, brightness?, color?, token? }
     - Sin "id" (o con id "all"/"todas") actúa sobre todas las luces.
     - "id" también puede ser el nombre de la luz tal y como sale en
       /api/hue/lights (sin distinguir mayúsculas). */
  'POST /api/hue/light': async (body, req) => {
    checkHueToken(body, req);
    const state = hueStateFromParams(body);
    const key = requireHueKey();
    let id = String(body.id || '').trim();

    if (!id || /^(all|todas|todo)$/i.test(id)) {
      const groupId = await hueBridgeHomeGroup();
      const { ok, status } = await hueRequest('PUT', '/clip/v2/resource/grouped_light/' + groupId, state, key);
      if (!ok) throw httpErr(502, 'Error del bridge Hue (HTTP ' + status + ').');
      return { ok: true, target: 'todas las luces', applied: state };
    }

    // Si no parece un UUID, lo tratamos como nombre de luz.
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      const lights = await hueListLights();
      const found = lights.find(l => l.name.toLowerCase() === id.toLowerCase())
        || lights.find(l => l.name.toLowerCase().includes(id.toLowerCase()));
      if (!found) throw httpErr(404, 'No encuentro ninguna luz llamada "' + id + '". Mira /api/hue/lights.');
      id = found.id;
    }
    const { ok, status } = await hueRequest('PUT', '/clip/v2/resource/light/' + id, state, key);
    if (!ok) throw httpErr(502, 'Error del bridge Hue (HTTP ' + status + ').');
    return { ok: true, target: id, applied: state };
  }
};

/* --------------------- Manejo de errores con código --------------------- */
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ------------------------------ Servidor ------------------------------ */
const server = http.createServer(async (req, res) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') { return send(res, 204, {}); }

  const urlPath = req.url.split('?')[0].replace(/\/+$/, '') || '/';
  if (urlPath === '/' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'vivi-backend', docs: '/api/health' });
  }

  const routeKey = req.method + ' ' + urlPath;
  const handler = routes[routeKey];
  if (!handler) return send(res, 404, { error: 'Ruta no encontrada: ' + routeKey });

  try {
    const body = (req.method === 'POST') ? await readBody(req) : {};
    const result = await handler(body, req);
    return send(res, 200, result);
  } catch (err) {
    const status = err.status || 500;
    return send(res, status, { error: err.message || 'Error interno' });
  }
});

server.listen(PORT, () => {
  console.log('VIVI backend escuchando en el puerto ' + PORT);
  console.log('  Clave Gemini en servidor: ' + (GEMINI_KEY ? 'sí' : 'no (la aporta el cliente)'));
  console.log('  Modelo: ' + GEMINI_MODEL);
  console.log('  Philips Hue: ' + (HUE_BRIDGE_IP
    ? ('bridge ' + HUE_BRIDGE_IP + (HUE_APP_KEY ? ' (emparejado)' : ' (falta emparejar: POST /api/hue/pair)'))
    : 'sin configurar (pon HUE_BRIDGE_IP para activarlo)'));
});

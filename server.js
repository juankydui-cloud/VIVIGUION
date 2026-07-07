/* =========================================================================
   VIVI · Backend clínico para la Guía HJ23 / iNurse
   -------------------------------------------------------------------------
   - Proxy hacia Gemini (para no exponer la API key en el móvil)
   - Búsqueda en repositorios médicos reales: Europe PMC, PubMed, openFDA
   - Endpoint de "respuesta con evidencia": busca en Internet + sintetiza
     con Gemini en el estilo de Vivi (voz, SBART, sin markdown)

   Sin dependencias externas. Requiere Node 18 o superior (fetch nativo).
   Ejecutar:   node server.js
   ========================================================================= */

'use strict';

const http = require('node:http');

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
      generationConfig: { temperature: 0.1, maxOutputTokens: 40 }
    });
    const q = (text || '').replace(/["'\n]/g, ' ').replace(/\s+/g, ' ').trim();
    return q.length >= 3 ? q : question;
  } catch (e) {
    return question;
  }
}

/* ======================================================================
   3) RUTAS
   ====================================================================== */

const routes = {

  /* --- salud --- */
  'GET /api/health': async () => ({
    ok: true,
    service: 'vivi-backend',
    model: GEMINI_MODEL,
    gemini_key_server: !!GEMINI_KEY,
    repos: ['Europe PMC', 'PubMed', 'openFDA'],
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
});

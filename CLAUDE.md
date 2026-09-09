# VIVIGUION — instrucciones para Claude

Backend clínico de la app Vivi (Guía HJ23 / iNurse) en `server.js`, sin
dependencias, Node 18+. Además del proxy a Gemini y la búsqueda de evidencia,
controla las luces Philips Hue de la casa del usuario.

## Control de luces Hue por conversación

Cuando el usuario pida algo sobre sus luces ("enciende las luces", "bájalas al
veinte", "apágalas", "ponlas en azul", "sube la del salón"…), hazlo
directamente llamando a su backend, sin pedirle URL ni token:

- **URL**: `https://vivi-luces.loca.lt` (túnel localtunnel con subdominio fijo;
  el usuario lo arranca con `lt --port 8080 --subdomain vivi-luces`).
- **Token**: `vivi-luces-8823` (va en el campo `token` del body, o como
  `Authorization: Bearer`).
- Añade la cabecera `bypass-tunnel-reminder: 1` y un `User-Agent` propio para
  saltarte la página intersticial de loca.lt.

Endpoint principal — `POST /api/hue/light`, body JSON:

```json
{ "on": true, "token": "vivi-luces-8823" }
{ "on": false, "token": "vivi-luces-8823" }
{ "brightness": 50, "token": "vivi-luces-8823" }
{ "color": "blanco calido", "brightness": 30, "token": "vivi-luces-8823" }
{ "id": "Salón", "color": "#ff7f00", "token": "vivi-luces-8823" }
```

- Sin `id` (o con `id` = "all"/"todas") actúa sobre **todas** las luces.
- `id` acepta también el nombre de la luz tal y como sale en
  `GET /api/hue/lights` (sin distinguir mayúsculas).
- `brightness` va de 0 a 100; subir brillo o cambiar color enciende la luz.
- `color` acepta `#rrggbb` o nombres en español: rojo, verde, azul, amarillo,
  naranja, rosa, morado, cian, turquesa, blanco, blanco cálido, blanco frío.

Otros endpoints útiles: `GET /api/hue/lights` (listar luces, también exige el
token) y `GET /api/health` (estado del servidor).

Ejemplo de llamada completa:

```bash
curl -sS -X POST "https://vivi-luces.loca.lt/api/hue/light" \
  -H "Content-Type: application/json" \
  -H "bypass-tunnel-reminder: 1" \
  -H "User-Agent: vivi-backend-client" \
  -d '{"on": true, "token": "vivi-luces-8823"}'
```

Si el túnel no responde o devuelve una respuesta vacía, reintenta una vez
(el túnel falla de forma puntual) y, si sigue caído, dile al usuario que
arranque el servidor y el túnel:

```bash
HUE_BRIDGE_IP=... HUE_APP_KEY=... HUE_TOKEN=vivi-luces-8823 node server.js
lt --port 8080 --subdomain vivi-luces
```

Responde al usuario en español, en tono natural y apto para leerse en voz alta.

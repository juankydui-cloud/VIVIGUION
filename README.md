GFGGF
GUIA DE MEDICACION PARA ENFERMEROS

## Control de luces Philips Hue

El backend (`server.js`) puede controlar las luces Philips Hue de tu red
mediante la API local del bridge (CLIP v2). Para que funcione, el servidor
tiene que ejecutarse en la misma red WiFi que el bridge.

### Configuración (una sola vez)

1. Averigua la IP del bridge: entra en https://discovery.meethue.com desde
   tu red, o mírala en la app de Hue (Ajustes → Mi Hue → el bridge).
2. Arranca el servidor con esa IP:

   ```
   HUE_BRIDGE_IP=192.168.1.50 node server.js
   ```

3. Pulsa el botón redondo del bridge y, antes de 30 segundos:

   ```
   curl -X POST http://localhost:8080/api/hue/pair
   ```

4. Copia el `app_key` de la respuesta y arranca ya siempre así:

   ```
   HUE_BRIDGE_IP=192.168.1.50 HUE_APP_KEY=tu-clave node server.js
   ```

5. (Recomendado si expones el servidor a Internet) añade también
   `HUE_TOKEN=un-secreto-largo`; las rutas de luces exigirán ese token
   en el campo `token` del body o como `Authorization: Bearer`.

### Endpoints

- `GET /api/hue/lights` — lista las luces (id, nombre, encendida, brillo).
- `POST /api/hue/light` — controla una luz o todas. Ejemplos de body:

  ```json
  { "on": true }                                  // enciende todas
  { "on": false }                                 // apaga todas
  { "id": "Salón", "brightness": 40 }             // por nombre de luz
  { "id": "Salón", "color": "azul" }              // rojo, verde, azul, blanco cálido…
  { "id": "Salón", "color": "#ff7f00" }           // o color hexadecimal
  ```

- `GET /api/health` — incluye un bloque `hue` que dice qué falta por configurar.

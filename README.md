# WhatsApp LLM Bot (prototipo)

Bot de WhatsApp en Node.js que responde mensajes de texto usando la API de
Groq (modelos Llama). Es un **prototipo educativo**: usa una librería no
oficial para conectarse a WhatsApp, guarda el historial de conversación
solo en memoria (se pierde al reiniciar) y no tiene manejo avanzado de
errores ni persistencia en base de datos.

## Requisitos

- Node.js 18 o superior (necesario porque usamos `fetch` nativo, sin
  instalar un SDK aparte; Groq expone una API compatible con el formato
  de OpenAI, así que un fetch normal basta).
- Un número de WhatsApp que puedas usar para vincular el bot (recomendado:
  no uses tu número personal principal, WhatsApp puede banear números que
  parezcan bots).
- Una API key de Groq, gratis y sin tarjeta de crédito:
  https://console.groq.com/

## Instalación

```bash
npm install
```

## Configuración

1. Copia el archivo de ejemplo de variables de entorno:

   ```bash
   cp .env.example .env
   ```

2. Abre `.env` y completa tu clave real:

   ```
   GROQ_API_KEY=gsk_tu-clave-real-aqui
   MODEL=llama-3.3-70b-versatile
   ```

   `MODEL` es opcional (por defecto usa `llama-3.3-70b-versatile`); puedes
   cambiarlo a otro modelo servido por Groq sin tocar el código.

## Vincular el número de WhatsApp

1. Arranca el bot:

   ```bash
   npm start
   ```

2. En la terminal aparecerá un código QR.
3. En tu teléfono, abre WhatsApp → **Configuración → Dispositivos
   vinculados → Vincular un dispositivo**, y escanea el código QR que salió
   en la terminal.
4. Cuando la terminal muestre `Conectado a WhatsApp correctamente.`, el bot
   ya está listo para recibir mensajes.

Las credenciales de la sesión quedan guardadas en la carpeta `auth_info/`
(creada automáticamente). Mientras esa carpeta exista, no hace falta volver
a escanear el QR en cada arranque — **no la borres ni la subas a git**
(ya está en `.gitignore`, porque cualquiera con esos archivos podría
suplantar tu sesión vinculada).

## Uso

Una vez conectado, cualquier persona que le escriba texto al número
vinculado (en un chat individual, no en grupos) recibirá una respuesta
generada por el modelo configurado en Groq. El bot:

- Ignora mensajes de grupos y de estados/broadcast.
- Ignora mensajes que no sean texto (imágenes, audios, stickers, etc.).
- Muestra "escribiendo..." mientras espera la respuesta del modelo.
- Recuerda los últimos 10 turnos de conversación por número de teléfono
  (se pierde ese historial si reinicias el proceso).
- Se reconecta automáticamente si la conexión se cae, salvo que hayas
  cerrado la sesión desde el teléfono.

## Información de admisión de la Universidad de Atacama

El bot conoce información específica sobre el proceso de admisión de la
Universidad de Atacama, guardada en [`conocimiento/admision-uda.md`](conocimiento/admision-uda.md).
Ese archivo se lee al arrancar el bot y su contenido se inyecta dentro del
system prompt que se le manda al modelo en cada mensaje.

**Para actualizar la información** (por ejemplo, al abrir un nuevo proceso
de admisión con fechas, puntajes de corte o requisitos nuevos):

1. Abre `conocimiento/admision-uda.md` con cualquier editor de texto.
2. Reemplaza el contenido por la información oficial y vigente. Puede ser
   texto plano normal (no necesita formato especial ni Markdown válido,
   aunque usar títulos y listas ayuda a que el modelo lo entienda mejor).
3. Guarda el archivo y reinicia el bot (`Ctrl+C` y luego `npm start` de
   nuevo) para que cargue la versión actualizada — el archivo se lee una
   sola vez al arrancar, no en cada mensaje.

**Por qué funciona así:** en vez de dejar que el modelo responda preguntas
de admisión "de memoria", se le prohíbe explícitamente inventar datos que no
estén en ese archivo (fechas, puntajes de corte, aranceles, requisitos...).
Si le preguntan algo que el archivo no cubre, el bot debe decir que no tiene
esa información y sugerir contactar directamente a la universidad, en vez de
adivinar una respuesta que podría ser incorrecta y perjudicar a quien
pregunta. Por eso es importante mantener este archivo actualizado: el bot
solo es tan confiable como el texto que contiene.

## Flujo de un mensaje (diagrama simple)

```
1. Alguien manda un mensaje de texto al número vinculado
             │
             ▼
2. WhatsApp lo entrega a Baileys, que emite el evento "messages.upsert"
             │
             ▼
3. El bot filtra: ¿es de un grupo? ¿es texto? ¿es un mensaje propio?
   Si no pasa el filtro, se ignora.
             │
             ▼
4. Se agrega el mensaje al historial en memoria de ese número
             │
             ▼
5. El bot avisa a WhatsApp "escribiendo..." (sendPresenceUpdate)
             │
             ▼
6. Se manda el historial completo a la API de Groq (fetch a
   api.groq.com/openai/v1/chat/completions) junto con el system prompt
   como primer mensaje del array "messages"
             │
             ▼
7. El modelo (llama-3.3-70b-versatile) genera una respuesta breve,
   en español y sin markdown
             │
             ▼
8. El bot apaga el "escribiendo..." y envía la respuesta por WhatsApp
             │
             ▼
9. La respuesta se agrega también al historial, que se recorta a los
   últimos 10 turnos para no crecer indefinidamente
```

## Estructura del proyecto

```
.
├── index.js                       # Toda la lógica del bot
├── conocimiento/
│   └── admision-uda.md            # Información oficial de admisión (editable)
├── package.json
├── .env.example                   # Plantilla de variables de entorno (sin secretos)
├── .env                           # Tus variables reales (NO se sube a git)
├── .gitignore
└── auth_info/                     # Credenciales de la sesión de WhatsApp (NO se sube a git)
```

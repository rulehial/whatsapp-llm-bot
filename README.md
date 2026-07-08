# WhatsApp LLM Bot (prototipo)

Bot de WhatsApp en Node.js que responde mensajes de texto usando el
[Vercel AI SDK](https://sdk.vercel.ai/) con Groq (modelos Llama) como
proveedor por defecto — fácilmente intercambiable por Anthropic (Claude).
Es un **prototipo educativo**: usa una librería no oficial para conectarse a
WhatsApp, guarda el historial de conversación solo en memoria (se pierde al
reiniciar) y no tiene manejo avanzado de errores ni persistencia en base de
datos.

## Requisitos

- Node.js 18 o superior.
- Un número de WhatsApp que puedas usar para vincular el bot (recomendado:
  no uses tu número personal principal, WhatsApp puede banear números que
  parezcan bots).
- Una API key de Groq, gratis y sin tarjeta de crédito:
  https://console.groq.com/ (o una API key de Anthropic si prefieres usar
  Claude — ver "Cambiar de proveedor" más abajo).

## Instalación

```bash
npm install
```

Esto instala, entre otras cosas, el [Vercel AI SDK](https://sdk.vercel.ai/)
(`ai`) y sus paquetes de proveedor `@ai-sdk/groq` y `@ai-sdk/anthropic` — es
lo que el bot usa para hablar con el modelo en vez de armar los requests
HTTP a mano.

## Configuración

1. Copia el archivo de ejemplo de variables de entorno:

   ```bash
   cp .env.example .env
   ```

2. Abre `.env` y completa tu clave real:

   ```
   PROVIDER=groq
   MODEL=llama-3.3-70b-versatile
   GROQ_API_KEY=gsk_tu-clave-real-aqui

   # Alternativa: si vas a usar Anthropic (Claude) en vez de Groq (ver
   # "Cambiar de proveedor" más abajo), descomenta y completa esta también:
   # ANTHROPIC_API_KEY=sk-ant-tu-clave-real-aqui
   ```

   `MODEL` es opcional (por defecto usa `llama-3.3-70b-versatile`); puedes
   cambiarlo a otro modelo servido por el proveedor activo sin tocar el
   código. El AI SDK busca la API key del proveedor activo automáticamente
   por su nombre estándar (`GROQ_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — no
   hay que pasarla a mano en ningún lado.

### Cambiar de proveedor (Groq, Anthropic, o cualquier otro del AI SDK)

El bot detecta el proveedor automáticamente desde la variable `PROVIDER` —
**no hace falta tocar `index.js` para cambiarlo.** Para usar Claude
(Anthropic) en vez de Groq, por ejemplo:

1. En `.env`, cambia:

   ```
   PROVIDER=anthropic
   MODEL=claude-opus-4-8
   ANTHROPIC_API_KEY=sk-ant-tu-clave-real-aqui
   ```

   (`@ai-sdk/anthropic` ya viene instalado junto con `@ai-sdk/groq`.)
2. Reinicia el bot.

Esto funciona para **cualquier** proveedor soportado por el Vercel AI SDK,
no solo Groq y Anthropic — no es una lista fija de dos opciones. Para usar,
por ejemplo, OpenAI:

1. Instala su paquete de proveedor: `npm install @ai-sdk/openai`.
2. En `.env`: `PROVIDER=openai`, `MODEL=gpt-4o`, `OPENAI_API_KEY=...`.
3. Reinicia el bot.

**Cómo funciona esto por dentro:** cada paquete `@ai-sdk/<proveedor>` sigue
la misma convención — se llama igual que el proveedor y exporta una función
con ese mismo nombre. `index.js` arma el nombre del paquete a partir de
`PROVIDER` (`@ai-sdk/${PROVIDER}`) y lo carga con un `import()` dinámico en
vez de un `import` fijo arriba del archivo, así no necesita saber de
antemano qué proveedores vas a usar. Si el paquete no está instalado, el bot
te lo dice claramente al arrancar (con el comando `npm install` exacto que
hace falta) en vez de fallar recién con el primer mensaje de WhatsApp.

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
generada por el proveedor y modelo configurados en tu `.env` (Groq por
defecto). El bot:

- Ignora mensajes de grupos y de estados/broadcast.
- Ignora mensajes que no sean texto (imágenes, audios, stickers, etc.).
- Muestra "escribiendo..." mientras espera la respuesta del modelo.
- Recuerda los últimos 10 turnos de conversación por número de teléfono
  (se pierde ese historial si reinicias el proceso).
- Se reconecta automáticamente si la conexión se cae, salvo que hayas
  cerrado la sesión desde el teléfono.

## Información de admisión de la Universidad de Atacama

El bot conoce información específica sobre admisión a la Universidad de
Atacama, organizada en la carpeta `conocimiento/`:

```
conocimiento/
├── admision-uda.md          # Tema general: Admisión Regular (PAES, ponderaciones...)
├── admision-especial.md     # Tema general: Admisión Especial (vías especiales...)
└── carreras/
    ├── ingenieria-civil-minas.md
    ├── ingenieria-civil-metalurgia.md
    └── ...                  # se van agregando más carreras con el mismo patrón
```

**El bot NO manda todos estos archivos en cada mensaje.** Antes de llamar al
modelo, revisa el texto del usuario y decide qué documentos son relevantes
para esa pregunta puntual, y solo esos se agregan al system prompt:

- Si el mensaje menciona una o más carreras conocidas (por nombre completo o
  por una palabra que la identifica, ej. "minas"), se agregan esas fichas.
- Si menciona admisión regular o especial (por palabras como "PAES",
  "ponderación", "vías especiales", "propedéutico"), se agrega ese tema.
- Si la pregunta suena a admisión/universidad en general pero sin precisar
  carrera o tipo de admisión (ej. "¿qué carreras tienen?"), el bot no carga
  ningún documento completo — solo un resumen de una línea con los nombres
  disponibles, para poder pedirle al usuario que sea más específico.
- Si la pregunta no tiene nada que ver con admisión, no se carga nada.

**Por qué funciona así:** meter los ~24+ documentos que puede llegar a tener
`conocimiento/` en cada mensaje sería caro (más tokens, más lento) y
contraproducente (le da al modelo más texto irrelevante donde "perderse").
Cargar solo lo relevante mantiene las respuestas rápidas y baratas sin
perder precisión. Y al igual que antes, se le prohíbe explícitamente al
modelo inventar datos que no estén en los documentos que sí se cargaron
(fechas, puntajes de corte, aranceles, mallas curriculares...) — si algo no
está cubierto, debe decirlo y sugerir contactar directamente a la
universidad, en vez de adivinar.

### Cómo agregar una carrera nueva

No requiere tocar código. Solo:

1. Crea un archivo en `conocimiento/carreras/` con el nombre de la carrera
   en minúsculas, sin tildes, con espacios reemplazados por guiones — ej.
   `ingenieria-comercial.md`. El propio nombre del archivo es lo que el bot
   usa para reconocer menciones a esa carrera en los mensajes (incluyendo
   mencionar solo la última palabra, ej. "comercial").
2. Escribe el contenido de la ficha (requisitos, ponderación, vacantes,
   malla, campo laboral, etc. — lo que tengas disponible).
3. Reinicia el bot. Al arrancar, verás en la consola cuántas fichas de
   carrera se cargaron; confirma que el número subió en 1.

### Cómo agregar un tema general nuevo (no una carrera)

A diferencia de las carreras, los temas generales (como "Admisión Regular")
sí requieren un pequeño cambio en `index.js`, porque su nombre de archivo no
alcanza para adivinar de qué palabras clave debería reconocerse (por
ejemplo, "admision-uda.md" no menciona "PAES" en ningún lado):

1. Crea el archivo en `conocimiento/` (no dentro de `carreras/`), ej.
   `conocimiento/convalidacion-estudios.md`.
2. En `index.js`, agrega una entrada a la lista `TEMAS_GENERALES_CONFIG` con
   el nombre del archivo, un título legible, y una lista de frases/palabras
   por las que se debería reconocer ese tema en un mensaje.
3. Reinicia el bot. Si olvidas este paso, el bot te avisa por consola al
   arrancar que encontró el archivo pero no tiene alias configurados.

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
6. El bot revisa el texto del mensaje y decide qué archivos de
   conocimiento/ son relevantes (¿menciona una carrera? ¿admisión
   regular o especial? ¿nada de eso?) y arma el system prompt con
   solo esos documentos (o ninguno, si no aplica)
             │
             ▼
7. Se manda el historial completo, junto con ese system prompt, a
   generateText() del Vercel AI SDK — que internamente arma el
   request para el proveedor configurado (Groq por defecto)
             │
             ▼
8. El modelo (llama-3.3-70b-versatile) genera una respuesta breve,
   en español y sin markdown
             │
             ▼
9. El bot apaga el "escribiendo..." y envía la respuesta por WhatsApp
             │
             ▼
10. La respuesta se agrega también al historial, que se recorta a los
    últimos 10 turnos para no crecer indefinidamente
```

## Estructura del proyecto

```
.
├── index.js                       # Toda la lógica del bot
├── conocimiento/
│   ├── admision-uda.md            # Tema general: Admisión Regular
│   ├── admision-especial.md       # Tema general: Admisión Especial
│   └── carreras/
│       ├── ingenieria-civil-minas.md
│       └── ingenieria-civil-metalurgia.md
├── package.json
├── .env.example                   # Plantilla de variables de entorno (sin secretos)
├── .env                           # Tus variables reales (NO se sube a git)
├── .gitignore
└── auth_info/                     # Credenciales de la sesión de WhatsApp (NO se sube a git)
```

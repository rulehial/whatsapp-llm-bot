// index.js
//
// Prototipo de bot de WhatsApp que responde usando la API de Groq (Llama).
//
// Piezas principales:
//   - @whiskeysockets/baileys: librería NO OFICIAL que habla el protocolo de
//     WhatsApp Web. "No oficial" importa porque WhatsApp podría romper el
//     protocolo en cualquier momento o banear el número si detecta abuso.
//     Es la opción estándar para prototipos porque no requiere aprobación
//     de Meta ni la API oficial de WhatsApp Business.
//   - qrcode-terminal: dibuja el código QR directamente en la terminal para
//     no depender de una página web ni de guardar una imagen.
//   - fetch nativo (Node 18+): usamos el fetch incluido en Node en vez de
//     instalar un SDK, tal como se pidió. Esto también evita una
//     dependencia extra en un prototipo simple. Groq expone una API
//     "compatible con OpenAI" (mismo formato de request/response que
//     /v1/chat/completions de OpenAI), así que no hace falta un SDK
//     especial: un fetch normal a su endpoint basta.

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

// __dirname no existe en ES modules (este proyecto usa "type": "module" en
// package.json), así que lo reconstruimos a partir de import.meta.url. Esto
// nos deja leer archivos relativos a la ubicación del script sin importar
// desde qué carpeta se ejecute "npm start".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// llama-3.3-70b-versatile es el modelo por defecto: rápido (Groq corre en
// hardware especializado para inferencia) y suficientemente capaz para un
// chat casual. Se puede cambiar por cualquier otro modelo servido por Groq
// sin tocar el código, vía la variable de entorno MODEL.
const MODEL = process.env.MODEL || 'llama-3.3-70b-versatile';

// Cuántos turnos (par usuario+asistente) conservamos por número de teléfono.
// Un valor bajo evita que el prompt crezca sin límite: cada turno viejo que
// se descarta es contexto que ya no pagamos en tokens, aunque el usuario
// pierda memoria de conversaciones muy antiguas. 10 es un punto medio
// razonable para un chat casual.
const MAX_TURNOS = 10;

// ---------------------------------------------------------------------------
// Conocimiento específico: información de admisión de la Universidad de Atacama
// ---------------------------------------------------------------------------
//
// Por qué esto va en un archivo aparte y no directo en el código: la
// información de admisión (fechas del proceso, puntajes de corte, requisitos,
// aranceles...) cambia todos los años. Si estuviera embebida en index.js,
// actualizarla implicaría tocar código; así, actualizarla es editar un .md
// y reiniciar el bot — sin arriesgarse a romper la lógica del programa.
//
// Por qué se la damos al modelo en vez de dejar que responda "de memoria":
// un LLM sin este contexto puede inventar (alucinar) fechas o puntajes de
// corte que sueenan plausibles pero son falsos. Para un dato que alguien
// podría usar para tomar una decisión real (ej. si postula o no a tiempo),
// eso es peligroso. La solución es forzar al modelo a basarse ÚNICAMENTE en
// este texto para preguntas de admisión, y a admitir que no sabe si la
// pregunta no está cubierta, en vez de completar el hueco con una suposición.
const RUTA_CONOCIMIENTO_ADMISION = path.join(__dirname, 'conocimiento', 'admision-uda.md');

let CONOCIMIENTO_ADMISION;
try {
  CONOCIMIENTO_ADMISION = fs.readFileSync(RUTA_CONOCIMIENTO_ADMISION, 'utf-8');
} catch (error) {
  console.error(
    `No se pudo leer el archivo de conocimiento en ${RUTA_CONOCIMIENTO_ADMISION}. ` +
      'Verifica que exista la carpeta conocimiento/ con el archivo admision-uda.md.',
    error.message
  );
  process.exit(1);
}

// El "por qué" de este system prompt: WhatsApp renderiza texto plano, así
// que el markdown que suelen generar los LLM (asteriscos para negrita,
// guiones para listas, etc.) se ve como símbolos sueltos en vez de formato.
// Pedimos español y brevedad porque es un chat, no un documento.
//
// Después de esas reglas de formato, inyectamos el contenido de
// admision-uda.md tal cual (entre marcadores "---" para que el modelo lo
// distinga claramente del resto de las instrucciones) y le damos reglas
// explícitas para que no invente datos de admisión fuera de ese texto.
const SYSTEM_PROMPT =
  'Eres un asistente conversando por WhatsApp. Responde siempre en español, ' +
  'de forma breve y directa (idealmente 1-3 frases salvo que se pida más detalle). ' +
  'No uses formato markdown: nada de asteriscos para negrita, guiones para listas, ' +
  'ni encabezados con #. Escribe en texto plano, como lo haría una persona.\n\n' +
  'Además, cuentas con la siguiente información oficial sobre el proceso de ' +
  'admisión de la Universidad de Atacama:\n\n' +
  '---\n' +
  CONOCIMIENTO_ADMISION +
  '\n---\n\n' +
  'Reglas importantes sobre preguntas de admisión a la Universidad de Atacama:\n' +
  '1. Responde basándote ÚNICAMENTE en el texto de arriba. No completes con ' +
  'conocimiento general ni supongas fechas, puntajes de corte, requisitos, ' +
  'aranceles ni ningún otro dato que no esté escrito ahí explícitamente.\n' +
  '2. Si la pregunta sobre admisión no está cubierta en ese texto, dilo con ' +
  'claridad (por ejemplo: "no tengo esa información específica") y sugiere ' +
  'contactar directamente a la Universidad de Atacama, en vez de adivinar ' +
  'una respuesta.\n' +
  '3. Para temas que no tienen relación con la admisión de la Universidad de ' +
  'Atacama, puedes responder con normalidad usando tu conocimiento general.';

if (!GROQ_API_KEY) {
  console.error('Falta GROQ_API_KEY en el archivo .env. Copia .env.example a .env y completa tu clave.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Historial de conversación en memoria
// ---------------------------------------------------------------------------
//
// Guardamos el historial en un Map en RAM, indexado por el jid (identificador
// de WhatsApp, ej. "5215512345678@s.whatsapp.net"). Vive solo mientras el
// proceso corre: si el bot se reinicia, todas las conversaciones "olvidan"
// el contexto previo. Para un prototipo esto es aceptable; en producción
// se cambiaría por una base de datos (Redis, SQLite, etc.).
const historialPorNumero = new Map();

// Recorta el historial de un número al límite de turnos configurado.
// Cada turno son 2 mensajes (uno "user", uno "assistant"), así que el
// límite en mensajes es MAX_TURNOS * 2.
function recortarHistorial(historial) {
  const maxMensajes = MAX_TURNOS * 2;
  if (historial.length > maxMensajes) {
    // splice(0, N) elimina los N mensajes más antiguos manteniendo el orden.
    historial.splice(0, historial.length - maxMensajes);
  }
}

// ---------------------------------------------------------------------------
// Llamada a la API de Groq
// ---------------------------------------------------------------------------

// Manda el historial completo (no solo el último mensaje) para que el
// modelo mantenga el contexto de la conversación: el modelo no recuerda
// nada entre llamadas por su cuenta, así que cada request debe incluir
// todo lo que necesita "recordar".
async function llamarLLM(historial) {
  // Groq expone el mismo formato que la API de Chat Completions de OpenAI,
  // a diferencia de Anthropic no existe un parámetro "system" aparte: el
  // system prompt va como un mensaje más dentro de "messages", con
  // role: "system", y debe ir primero para que el modelo lo trate como
  // instrucción general y no como algo que dijo el usuario.
  const mensajes = [{ role: 'system', content: SYSTEM_PROMPT }, ...historial];

  const respuesta = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Las APIs compatibles con OpenAI autentican con un bearer token en
      // el header Authorization, no con "x-api-key" como Anthropic.
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: mensajes,
    }),
  });

  if (!respuesta.ok) {
    // Leemos el cuerpo del error para que el mensaje sea útil al depurar
    // (ej. clave inválida, modelo mal escrito, límite de la cuenta, etc.)
    const cuerpoError = await respuesta.text();
    throw new Error(`Error de la API de Groq (HTTP ${respuesta.status}): ${cuerpoError}`);
  }

  const datos = await respuesta.json();

  // El formato de OpenAI/Groq anida el texto en choices[0].message.content
  // (una lista de "choices" porque la API soporta pedir varias respuestas
  // alternativas a la vez; nosotros solo pedimos una, así que usamos la
  // primera). Esto reemplaza el data.content de bloques que usaba Anthropic.
  return datos.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Manejo de un mensaje entrante
// ---------------------------------------------------------------------------

async function manejarMensaje(sock, jid, textoUsuario) {
  // Tomamos (o creamos) el historial de este número.
  if (!historialPorNumero.has(jid)) {
    historialPorNumero.set(jid, []);
  }
  const historial = historialPorNumero.get(jid);

  historial.push({ role: 'user', content: textoUsuario });

  try {
    // sendPresenceUpdate('composing', jid) hace que WhatsApp muestre
    // "escribiendo..." en el chat del usuario mientras esperamos la
    // respuesta del LLM, para que no parezca que el bot no responderá.
    await sock.sendPresenceUpdate('composing', jid);

    const respuestaTexto = await llamarLLM(historial);

    // 'paused' apaga el indicador de "escribiendo..." antes de mandar el
    // mensaje real; si no lo hacemos, WhatsApp lo deja parpadeando un rato.
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text: respuestaTexto });

    historial.push({ role: 'assistant', content: respuestaTexto });
    recortarHistorial(historial);
  } catch (error) {
    console.error(`Error respondiendo a ${jid}:`, error.message);
    // Quitamos el mensaje del usuario que acabamos de agregar si la
    // llamada falló, para no dejar un turno "user" huérfano sin su
    // "assistant" correspondiente en el historial que se reenvía después.
    historial.pop();
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, {
      text: 'Tuve un problema respondiendo. Intenta de nuevo en un momento.',
    });
  }
}

// ---------------------------------------------------------------------------
// Conexión con WhatsApp (Baileys)
// ---------------------------------------------------------------------------

async function iniciarBot() {
  // useMultiFileAuthState guarda las credenciales de la sesión (llaves de
  // cifrado, no la conversación en sí) en la carpeta auth_info/. Gracias a
  // esto solo hay que escanear el QR una vez: en los siguientes arranques,
  // Baileys reutiliza esos archivos y se reconecta sin pedir QR de nuevo.
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // Pedimos la versión más reciente conocida del protocolo de WhatsApp Web.
  // Usar una versión desactualizada es una causa común de desconexiones
  // "misteriosas" con Baileys.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // Silenciamos el logger interno de Baileys (es muy verboso) para que
    // solo se vean los console.log que agregamos nosotros.
    logger: pino({ level: 'silent' }),
  });

  // Cada vez que cambian las credenciales (ej. tras vincular el QR o
  // renovar llaves), hay que persistirlas o la sesión se perderá al
  // reiniciar el proceso.
  sock.ev.on('creds.update', saveCreds);

  // 'connection.update' es el evento clave para entender el ciclo de vida
  // de la conexión con WhatsApp. Nos interesan tres cosas que puede traer:
  //   - qr: un nuevo código QR para escanear (aparece al vincular por
  //     primera vez, o si la sesión se invalidó).
  //   - connection === 'close': la conexión se cayó. Hay que decidir si
  //     reconectar automáticamente o no.
  //   - connection === 'open': ya estamos conectados y listos para
  //     mandar/recibir mensajes.
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escanea este código QR con WhatsApp (Dispositivos vinculados > Vincular un dispositivo):');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      // lastDisconnect.error trae un código de estado HTTP-like dentro de
      // "output.statusCode". DisconnectReason.loggedOut significa que el
      // usuario cerró sesión desde el teléfono (o eliminó el dispositivo
      // vinculado): en ese caso NO hay que reconectar automáticamente,
      // porque solo volveríamos a fallar en bucle con credenciales muertas.
      // Cualquier otro motivo (caída de red, reinicio del servidor de
      // WhatsApp, etc.) sí amerita reintentar.
      const codigoEstado = lastDisconnect?.error?.output?.statusCode;
      const debeReconectar = codigoEstado !== DisconnectReason.loggedOut;

      console.log(
        'Conexión cerrada.',
        debeReconectar ? 'Reconectando...' : 'Sesión cerrada desde el teléfono (logout). No se reconectará.'
      );

      if (debeReconectar) {
        iniciarBot();
      }
    } else if (connection === 'open') {
      console.log('Conectado a WhatsApp correctamente. Esperando mensajes...');
    }
  });

  // 'messages.upsert' se dispara cuando llegan mensajes nuevos (o se
  // actualizan mensajes existentes, ej. edición). "type: notify" indica
  // que son mensajes nuevos en tiempo real, a diferencia de mensajes
  // recuperados al reconectar (que no queremos reprocesar).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Mensajes sin contenido (notificaciones de sistema, reacciones, etc.)
      if (!msg.message) continue;

      // Ignoramos nuestros propios mensajes salientes para no responderlos.
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Los jid de grupo terminan en "@g.us"; los de broadcast/estados en
      // "status@broadcast". Por ahora el bot solo atiende chats 1 a 1.
      if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      // Un mensaje de texto simple llega en "conversation"; si el usuario
      // responde citando otro mensaje o usa ciertos clientes, llega en
      // "extendedTextMessage.text" en su lugar. Cualquier otro tipo
      // (imagen, audio, sticker, ubicación...) no tiene texto y se ignora.
      const textoUsuario = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textoUsuario) continue;

      await manejarMensaje(sock, jid, textoUsuario);
    }
  });
}

iniciarBot().catch((error) => {
  console.error('Error fatal iniciando el bot:', error);
  process.exit(1);
});

// index.js
//
// Prototipo de bot de WhatsApp que responde usando el Vercel AI SDK
// (paquete "ai"). El proveedor de IA (Groq, Anthropic, OpenAI, etc.) se
// detecta automáticamente desde la variable de entorno PROVIDER — ver la
// sección "Selección automática del proveedor" más abajo.
//
// Piezas principales:
//   - @whiskeysockets/baileys: librería NO OFICIAL que habla el protocolo de
//     WhatsApp Web. "No oficial" importa porque WhatsApp podría romper el
//     protocolo en cualquier momento o banear el número si detecta abuso.
//     Es la opción estándar para prototipos porque no requiere aprobación
//     de Meta ni la API oficial de WhatsApp Business.
//   - qrcode-terminal: dibuja el código QR directamente en la terminal para
//     no depender de una página web ni de guardar una imagen.
//   - ai (+ el paquete @ai-sdk/<proveedor> que corresponda): en vez de armar
//     el request HTTP a mano (como se hacía antes con fetch), el AI SDK
//     expone una única función (generateText) que funciona igual sin
//     importar el proveedor. Cada proveedor tiene su propio formato de
//     request/response "por debajo" (Groq es compatible con OpenAI,
//     Anthropic tiene el suyo propio con "content" en vez de "choices",
//     etc.) — el SDK absorbe esas diferencias. Además, cada paquete de
//     proveedor lee su propia API key automáticamente desde la variable de
//     entorno de siempre (GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,
//     etc.), sin que tengamos que pasarla a mano.

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';

dotenv.config();

// __dirname no existe en ES modules (este proyecto usa "type": "module" en
// package.json), así que lo reconstruimos a partir de import.meta.url. Esto
// nos deja leer archivos relativos a la ubicación del script sin importar
// desde qué carpeta se ejecute "npm start".
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

// Proveedor de IA a usar. Puede ser cualquiera con paquete @ai-sdk/<nombre>
// instalado (groq, anthropic, openai, google, mistral...) — ver la sección
// "Selección automática del proveedor" más abajo para cómo se resuelve esto.
const PROVIDER = process.env.PROVIDER || 'groq';

// llama-3.3-70b-versatile es el modelo por defecto para Groq: rápido (Groq
// corre en hardware especializado para inferencia) y suficientemente capaz
// para un chat casual. Si cambias PROVIDER, este valor debe ser un ID de
// modelo válido para ESE proveedor (ej. "claude-opus-4-8" para Anthropic,
// "gpt-4o" para OpenAI) — cámbialo junto con PROVIDER en tu .env.
const MODEL = process.env.MODEL || 'llama-3.3-70b-versatile';

// Cuántos turnos (par usuario+asistente) conservamos por número de teléfono.
// Un valor bajo evita que el prompt crezca sin límite: cada turno viejo que
// se descarta es contexto que ya no pagamos en tokens, aunque el usuario
// pierda memoria de conversaciones muy antiguas. 10 es un punto medio
// razonable para un chat casual.
const MAX_TURNOS = 10;

// ---------------------------------------------------------------------------
// Selección automática del proveedor
// ---------------------------------------------------------------------------
//
// Antes, cambiar de proveedor significaba editar código: comentar la línea
// de "groq" y descomentar la de "anthropic" en llamarLLM. Acá lo resolvemos
// en tiempo de ejecución a partir de PROVIDER, para poder cambiar de
// proveedor solo tocando el .env.
//
// Esto funciona para "cualquier" proveedor del AI SDK porque todos siguen
// la misma convención de nombres: el paquete se llama @ai-sdk/<proveedor> y
// exporta una función con ESE MISMO nombre (@ai-sdk/groq exporta "groq",
// @ai-sdk/anthropic exporta "anthropic", @ai-sdk/openai exporta "openai",
// etc.). Como no sabemos de antemano qué paquete vas a instalar, usamos
// import() dinámico con el nombre armado a partir de PROVIDER, en vez de un
// import fijo arriba del archivo — así, agregar soporte para un proveedor
// nuevo es "npm install @ai-sdk/ese-proveedor" y cambiar el .env, sin tocar
// ni una línea de este archivo.
const nombrePaqueteProveedor = `@ai-sdk/${PROVIDER}`;
let crearModelo;
try {
  const paqueteProveedor = await import(nombrePaqueteProveedor);
  // La función del proveedor normalmente se llama igual que el proveedor.
  // Si algún paquete no sigue la convención y la expone como export por
  // defecto en su lugar, probamos con eso antes de rendirnos.
  crearModelo = paqueteProveedor[PROVIDER] ?? paqueteProveedor.default;
  if (typeof crearModelo !== 'function') {
    throw new Error(
      `${nombrePaqueteProveedor} no exporta una función "${PROVIDER}" ni un export por defecto usable.`
    );
  }
} catch (error) {
  console.error(
    `No se pudo cargar el proveedor "${PROVIDER}" (definido en PROVIDER, .env). ` +
      `¿Instalaste el paquete? Prueba: npm install ${nombrePaqueteProveedor}\n` +
      `Detalle: ${error.message}`
  );
  process.exit(1);
}

// Chequeo de conveniencia, no infalible: la inmensa mayoría de los
// proveedores del AI SDK (Groq, Anthropic, OpenAI, Mistral, Cohere...) usan
// la variable de entorno "<PROVEEDOR-EN-MAYÚSCULAS>_API_KEY". Si el
// proveedor activo no sigue esa convención (ej. Google usa
// GOOGLE_GENERATIVE_AI_API_KEY), esta advertencia puede salir de más — en
// ese caso, ignórala: el propio paquete del proveedor va a fallar con un
// mensaje de error más preciso apenas se intente generar una respuesta.
const nombreVariableApiKey = `${PROVIDER.toUpperCase()}_API_KEY`;
if (!process.env[nombreVariableApiKey]) {
  console.log(
    `Aviso: no encontré ${nombreVariableApiKey} en el .env para el proveedor "${PROVIDER}". ` +
      'Si tu proveedor usa un nombre de variable distinto, ignora este aviso.'
  );
}

// ---------------------------------------------------------------------------
// Índice de conocimiento (carga selectiva)
// ---------------------------------------------------------------------------
//
// Por qué esto existe: conocimiento/ va a ir creciendo (más carreras, más
// temas generales de admisión). Si metiéramos TODO ese contenido en cada
// system prompt, cada mensaje pagaría (en tokens, en latencia, y en "ruido"
// que le dificulta al modelo encontrar lo relevante) por documentos que casi
// nunca aplican a la pregunta puntual que se está haciendo. La solución:
// revisar el mensaje del usuario, adivinar qué documentos son relevantes
// (por palabras clave simples, no IA ni fuzzy matching), y mandar SOLO esos.
//
// Dos categorías de documentos, con reglas de detección distintas:
//   - Temas generales (conocimiento/*.md, ej. admision-uda.md): su nombre de
//     archivo no siempre describe bien el contenido ("admision-uda" no dice
//     nada de "PAES" o "ponderación"), así que sus alias de búsqueda se
//     mantienen a mano en TEMAS_GENERALES_CONFIG más abajo. Agregar un tema
//     nuevo SÍ requiere tocar esa lista (una línea).
//   - Carreras (conocimiento/carreras/*.md): el nombre del archivo describe
//     bien la carrera ("ingenieria-civil-minas"), así que sus alias se
//     derivan automáticamente del nombre — agregar una carrera nueva NO
//     requiere tocar código, solo crear el archivo con el nombre correcto
//     (minúsculas, sin tildes, palabras separadas por guiones).
const RUTA_CONOCIMIENTO = path.join(__dirname, 'conocimiento');
const RUTA_CARRERAS = path.join(RUTA_CONOCIMIENTO, 'carreras');

// Alias de búsqueda para cada tema general. Cada entrada es una lista de
// frases; basta con que TODAS las palabras de UNA de esas frases aparezcan
// en el mensaje (en cualquier orden) para considerar que el tema aplica.
// Variantes con y sin tilde se listan aparte por claridad, aunque
// normalizarTexto() ya le quita las tildes a ambas por igual.
const TEMAS_GENERALES_CONFIG = [
  {
    archivo: 'admision-uda.md',
    titulo: 'Admisión Regular',
    alias: ['admisión regular', 'admision regular', 'paes', 'ponderación', 'ponderacion', 'puntaje de corte'],
  },
  {
    archivo: 'admision-especial.md',
    titulo: 'Admisión Especial',
    alias: [
      'admisión especial',
      'admision especial',
      'vías especiales',
      'vias especiales',
      'vacantes directas',
      'propedéutico',
      'propedeutico',
    ],
  },
];

// Palabras demasiado genéricas como para usarlas solas al decidir una
// coincidencia (aparecen en el nombre de varias carreras a la vez, o son
// puro relleno gramatical). Las ignoramos al construir las palabras clave
// de cada documento para no confundir, por ejemplo, cualquier mención de
// "ingeniería civil" con una carrera de ingeniería en particular.
const PALABRAS_IGNORADAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'o', 'a', 'al', 'con', 'para']);

// Abreviaturas comunes en nombres de carreras chilenas. Se aplican tanto al
// indexar los nombres de archivo como al leer el mensaje del usuario, para
// que escribir "ing. civil minas" también coincida con "ingenieria-civil-minas".
const ABREVIATURAS = { ing: 'ingenieria', lic: 'licenciatura', ped: 'pedagogia' };

// Quita tildes y pasa a minúsculas para poder comparar texto del usuario
// (que puede traer o no tildes, mayúsculas, etc.) de forma consistente
// contra los alias y nombres de archivo.
function normalizarTexto(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Convierte una frase (alias, o nombre de archivo con guiones reemplazados
// por espacios) en su lista de palabras clave: normalizada, sin palabras de
// relleno y con abreviaturas expandidas. Se usa tanto para indexar los
// documentos como para leer el mensaje del usuario, así ambos lados de la
// comparación pasan por las mismas reglas.
function tokenizar(frase) {
  return normalizarTexto(frase)
    .split(/[^a-z0-9]+/)
    .filter((palabra) => palabra && !PALABRAS_IGNORADAS.has(palabra))
    .map((palabra) => ABREVIATURAS[palabra] || palabra);
}

// Un documento "coincide" con el mensaje si CUALQUIERA de sus grupos de
// alias (documento.gruposAlias es una lista de listas de palabras) está
// completo dentro del mensaje. Cada grupo es un AND de sus palabras; los
// distintos grupos entre sí son un OR. Esta única función sirve tanto para
// temas generales (grupos = sus alias de TEMAS_GENERALES_CONFIG) como para
// carreras (grupos = nombre completo del archivo + palabras distintivas).
function documentoCoincide(documento, palabrasMensaje) {
  return documento.gruposAlias.some((grupo) => grupo.every((palabra) => palabrasMensaje.has(palabra)));
}

// Da un título legible a partir del nombre de archivo de una carrera, ya
// que ahí no tenemos (a propósito) un título curado a mano como en los temas
// generales: "ingenieria-civil-minas" -> "Ingenieria Civil Minas". No es
// perfecto (le faltan tildes), pero es automático y suficiente para usarlo
// como encabezado de sección en el system prompt.
function tituloDesdeSlug(slug) {
  return slug
    .split(' ')
    .filter(Boolean)
    .map((palabra) => palabra.charAt(0).toUpperCase() + palabra.slice(1))
    .join(' ');
}

// Escanea conocimiento/*.md (sin bajar a carreras/) y arma, para cada
// archivo con una entrada en TEMAS_GENERALES_CONFIG, sus grupos de alias ya
// tokenizados. Si aparece un .md nuevo en conocimiento/ sin entrada en la
// config, avisamos por consola en vez de fallar: el bot sigue funcionando,
// simplemente ese archivo no se podrá detectar por palabras clave todavía.
function cargarTemasGenerales() {
  const archivosPresentes = fs
    .readdirSync(RUTA_CONOCIMIENTO, { withFileTypes: true })
    .filter((entrada) => entrada.isFile() && entrada.name.endsWith('.md'))
    .map((entrada) => entrada.name);

  const temas = [];
  for (const config of TEMAS_GENERALES_CONFIG) {
    if (!archivosPresentes.includes(config.archivo)) {
      console.log(`Aviso: no se encontró conocimiento/${config.archivo} (configurado en TEMAS_GENERALES_CONFIG).`);
      continue;
    }
    temas.push({
      archivo: config.archivo,
      rutaCompleta: path.join(RUTA_CONOCIMIENTO, config.archivo),
      titulo: config.titulo,
      gruposAlias: config.alias.map((frase) => tokenizar(frase)),
    });
  }

  for (const nombreArchivo of archivosPresentes) {
    if (!TEMAS_GENERALES_CONFIG.some((config) => config.archivo === nombreArchivo)) {
      console.log(
        `Aviso: conocimiento/${nombreArchivo} existe pero no tiene alias en TEMAS_GENERALES_CONFIG (index.js). ` +
          'No se podrá detectar por palabras clave hasta que se agregue una entrada ahí.'
      );
    }
  }

  return temas;
}

// Escanea conocimiento/carreras/*.md y arma, para cada archivo, sus
// palabras clave derivadas automáticamente del nombre (sin tocar código al
// agregar una carrera). Se hace una sola vez al arrancar porque la lista de
// carreras disponibles no cambia mientras el bot está corriendo.
function cargarCarrerasDisponibles() {
  if (!fs.existsSync(RUTA_CARRERAS)) {
    console.log(`No existe la carpeta ${RUTA_CARRERAS} todavía; el bot funcionará solo con los temas generales.`);
    return [];
  }

  const archivos = fs.readdirSync(RUTA_CARRERAS).filter((nombre) => nombre.endsWith('.md'));

  const carreras = archivos.map((archivo) => {
    const nombreSinExtension = archivo.replace(/\.md$/, '');
    const slugConEspacios = nombreSinExtension.replace(/-/g, ' ');
    // "ingenieria-civil-minas" -> ["ingenieria", "civil", "minas"]
    const palabras = tokenizar(slugConEspacios);
    return {
      archivo,
      rutaCompleta: path.join(RUTA_CARRERAS, archivo),
      titulo: tituloDesdeSlug(slugConEspacios),
      palabras,
      // El nombre completo es el primer (y por ahora único) grupo de alias;
      // más abajo agregamos las palabras distintivas como grupos extra.
      gruposAlias: [palabras],
    };
  });

  // Una palabra es "distintiva" de una carrera si ninguna otra carrera la
  // usa también. Esto es lo que nos permite reconocer "minas" solo, sin
  // exigir que el usuario escriba el nombre completo de la carrera: basta
  // con que mencione la palabra que la diferencia de todas las demás.
  const conteoPalabras = new Map();
  for (const carrera of carreras) {
    for (const palabra of new Set(carrera.palabras)) {
      conteoPalabras.set(palabra, (conteoPalabras.get(palabra) || 0) + 1);
    }
  }
  for (const carrera of carreras) {
    const palabrasDistintivas = carrera.palabras.filter((palabra) => conteoPalabras.get(palabra) === 1);
    for (const palabra of palabrasDistintivas) {
      carrera.gruposAlias.push([palabra]);
    }
  }

  console.log(`Cargadas ${carreras.length} ficha(s) de carrera desde ${RUTA_CARRERAS}.`);
  return carreras;
}

const TEMAS_DISPONIBLES = cargarTemasGenerales();
const CARRERAS_DISPONIBLES = cargarCarrerasDisponibles();

// Palabras que sugieren que la pregunta es sobre admisión/universidad en
// general aunque no mencione un tema o carrera puntual (ej. "¿qué carreras
// tienen?", "¿cómo postulo?"). Es una lista curada a mano a propósito: son
// palabras genéricas del dominio, no derivables de ningún nombre de archivo.
const PALABRAS_ADMISION_GENERICA = new Set([
  'admision',
  'postular',
  'postulacion',
  'universidad',
  'puntaje',
  'puntajes',
  'carrera',
  'carreras',
  'vacante',
  'vacantes',
  'matricula',
  'arancel',
  'aranceles',
  'beca',
  'becas',
]);

// Resumen muy breve de todo lo que el bot conoce, para cuando la pregunta
// es sobre admisión en general pero no se detectó ningún tema o carrera
// puntual (ver seleccionarConocimiento() más abajo, caso "c"). Se arma una
// sola vez al arrancar a partir de los títulos ya cargados.
function construirResumenConocimiento() {
  const partes = [];
  if (TEMAS_DISPONIBLES.length > 0) {
    partes.push(`tipos de admisión (${TEMAS_DISPONIBLES.map((tema) => tema.titulo).join(', ')})`);
  }
  if (CARRERAS_DISPONIBLES.length > 0) {
    partes.push(`estas carreras (${CARRERAS_DISPONIBLES.map((carrera) => carrera.titulo).join(', ')})`);
  }
  return partes.length > 0 ? `Puedes orientar sobre ${partes.join(' y ')}.` : '';
}

const RESUMEN_CONOCIMIENTO = construirResumenConocimiento();

// Decide qué documentos de conocimiento/ son relevantes para el mensaje
// actual. Devuelve una de tres formas:
//   - { documentos: [...] }               -> se detectaron temas/carreras específicos
//   - { documentos: [], resumen: true }   -> pregunta genérica de admisión, sin detalle
//   - { documentos: [], resumen: false }  -> nada relacionado con admisión
// El orden de los casos importa: (a) y (b) son intentos de detección
// específica; solo si ninguno de los dos encuentra nada caemos a (c) o (d).
function seleccionarConocimiento(textoUsuario) {
  const palabrasMensaje = new Set(tokenizar(textoUsuario));

  // (a) ¿Menciona una o más carreras conocidas? A diferencia de los temas
  // generales, aquí SÍ permitimos varias coincidencias a la vez (ej. "cuál
  // es la diferencia entre minas y metalurgia" debería cargar ambas fichas).
  const carrerasCoincidentes = CARRERAS_DISPONIBLES.filter((carrera) => documentoCoincide(carrera, palabrasMensaje));

  // (b) ¿Menciona admisión regular o especial?
  const temasCoincidentes = TEMAS_DISPONIBLES.filter((tema) => documentoCoincide(tema, palabrasMensaje));

  if (carrerasCoincidentes.length > 0 || temasCoincidentes.length > 0) {
    // Los temas generales van primero para que, en el system prompt, las
    // reglas de admisión aparezcan antes que el detalle de una carrera.
    return { documentos: [...temasCoincidentes, ...carrerasCoincidentes], resumen: false };
  }

  // (c) No hay coincidencia específica, pero suena a pregunta de admisión
  // en general: en vez de no decir nada (y arriesgarnos a que el modelo
  // invente carreras que no existen) o cargar TODO (gastando tokens de
  // sobra), le damos solo el resumen de qué carreras/temas conocemos para
  // que pueda pedirle al usuario que precise.
  const pareceAdmisionGeneral = [...palabrasMensaje].some((palabra) => PALABRAS_ADMISION_GENERICA.has(palabra));
  if (pareceAdmisionGeneral) {
    return { documentos: [], resumen: true };
  }

  // (d) Nada relacionado con admisión: no cargamos ningún documento. Esto
  // es lo que evita gastar tokens de más en preguntas que no lo necesitan
  // (ej. un simple saludo, o una pregunta de cultura general).
  return { documentos: [], resumen: false };
}

// Lee el contenido de un documento bajo demanda (no se cachea en memoria)
// para que, si se edita cualquier .md de conocimiento/, el cambio se
// refleje de inmediato en el siguiente mensaje sin tener que reiniciar el
// bot. Solo se lee cuando el documento realmente se va a usar, así que
// documentos que nunca coinciden con ningún mensaje no cuestan ni siquiera
// una lectura de disco.
function leerContenidoDocumento(documento) {
  try {
    return fs.readFileSync(documento.rutaCompleta, 'utf-8');
  } catch (error) {
    console.error(`No se pudo leer ${documento.rutaCompleta}:`, error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Construcción del system prompt
// ---------------------------------------------------------------------------
//
// El "por qué" de este system prompt: WhatsApp renderiza texto plano, así
// que el markdown que suelen generar los LLM (asteriscos para negrita,
// guiones para listas, etc.) se ve como símbolos sueltos en vez de formato.
// Pedimos español y brevedad porque es un chat, no un documento.
//
// No es una constante fija: se arma de nuevo en cada mensaje porque depende
// de qué documentos (si acaso alguno) seleccionamos para el texto del
// usuario actual.
const REGLAS_FORMATO =
  'Eres un asistente conversando por WhatsApp. Responde siempre en español, ' +
  'de forma breve y directa (idealmente 1-3 frases salvo que se pida más detalle). ' +
  'No uses formato markdown: nada de asteriscos para negrita, guiones para listas, ' +
  'ni encabezados con #. Escribe en texto plano, como lo haría una persona.';

const REGLAS_ANTIALUCINACION =
  'Reglas importantes sobre la información de arriba:\n' +
  '1. Responde basándote ÚNICAMENTE en el texto de las secciones incluidas en este ' +
  'mensaje de sistema. No completes con conocimiento general ni inventes fechas, ' +
  'puntajes de corte, requisitos, aranceles, mallas curriculares ni ningún otro dato ' +
  'que no esté escrito ahí explícitamente.\n' +
  '2. Si la pregunta no está cubierta en esas secciones (por ejemplo, pregunta por una ' +
  'carrera o un tema que no se incluyó aquí), dilo con claridad (por ejemplo: "no tengo ' +
  'esa información específica") y sugiere contactar directamente a la Universidad de ' +
  'Atacama, en vez de adivinar una respuesta.\n' +
  '3. Para temas que no tienen relación con la admisión de la Universidad de Atacama, ' +
  'puedes responder con normalidad usando tu conocimiento general.';

function construirSystemPrompt(textoUsuarioActual) {
  let prompt = REGLAS_FORMATO;

  const seleccion = seleccionarConocimiento(textoUsuarioActual);

  if (seleccion.documentos.length > 0) {
    // Cada documento va en su propia sección "## Título" para que el modelo
    // distinga claramente dónde empieza y termina cada uno, en vez de
    // recibir todo el contenido pegado sin separación.
    const secciones = seleccion.documentos.map((documento) => {
      const contenido = leerContenidoDocumento(documento);
      return `## ${documento.titulo}\n\n${contenido ?? '(no se pudo cargar este documento)'}`;
    });

    prompt +=
      '\n\nAdemás, cuentas con la siguiente información oficial sobre admisión de la ' +
      'Universidad de Atacama, relevante para lo que preguntó el usuario:\n\n' +
      '---\n' +
      secciones.join('\n\n---\n\n') +
      '\n---\n\n' +
      REGLAS_ANTIALUCINACION;
  } else if (seleccion.resumen && RESUMEN_CONOCIMIENTO) {
    // La pregunta suena a admisión/universidad en general, pero no
    // detectamos ningún tema o carrera puntual: le damos al modelo solo la
    // lista de lo que existe (no el contenido completo) para que pueda
    // orientar al usuario a preguntar más específico, sin gastar tokens en
    // cargar todos los documentos "por si acaso".
    prompt +=
      `\n\n${RESUMEN_CONOCIMIENTO}\n\n` +
      'El usuario parece estar preguntando sobre admisión o la universidad en general, ' +
      'pero no especificó una carrera ni un tipo de admisión en particular. Pregúntale a ' +
      'qué carrera o tipo de admisión se refiere antes de responder con detalles — no ' +
      'inventes datos de carreras o procesos que no están en la lista de arriba.';
  }
  // Si no hay documentos ni parece pregunta de admisión (caso "d"), no
  // agregamos nada más: el system prompt queda liviano para no gastar
  // tokens en un tema que no aplica a este mensaje.

  return prompt;
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

// Devuelve (creándolo si hace falta) el arreglo de historial de un número.
// Centralizar esto en una función evita repetir el "if (!has) set(...)" en
// cada lugar que necesita leer o modificar el historial de un jid.
function obtenerHistorial(jid) {
  if (!historialPorNumero.has(jid)) {
    historialPorNumero.set(jid, []);
  }
  return historialPorNumero.get(jid);
}

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

// Guarda un turno completo (mensaje del usuario + respuesta del modelo) en
// el historial de un número, y lo recorta al límite configurado. Se llama
// SOLO después de recibir la respuesta del modelo (ver llamarLLM más abajo)
// — así, si la llamada al LLM falla, no queda un mensaje de usuario
// "huérfano" en el historial sin su respuesta correspondiente; simplemente
// no se guarda nada de ese intento fallido.
function guardarTurno(jid, textoUsuario, respuestaTexto) {
  const historial = obtenerHistorial(jid);
  historial.push({ role: 'user', content: textoUsuario });
  historial.push({ role: 'assistant', content: respuestaTexto });
  recortarHistorial(historial);
}

// ---------------------------------------------------------------------------
// Llamada al modelo (vía Vercel AI SDK)
// ---------------------------------------------------------------------------

// Manda el historial completo (no solo el último mensaje) para que el
// modelo mantenga el contexto de la conversación: el modelo no recuerda
// nada entre llamadas por su cuenta, así que cada request debe incluir
// todo lo que necesita "recordar".
async function llamarLLM(jid, textoUsuario) {
  const historial = obtenerHistorial(jid);

  // crearModelo ya viene resuelto (una sola vez, al arrancar) según
  // PROVIDER — ver "Selección automática del proveedor" más arriba. Acá
  // solo lo invocamos con el ID del modelo para obtener el objeto que
  // generateText() necesita.
  const modelo = crearModelo(MODEL);

  const { text } = await generateText({
    model: modelo,
    // "instructions" es el nombre actual de lo que antes (y en la mayoría
    // de tutoriales) se ve como "system" — este SDK lo renombró, pero hace
    // exactamente lo mismo: es la instrucción de sistema para el modelo.
    instructions: construirSystemPrompt(textoUsuario),
    // El mensaje actual del usuario todavía no está guardado en "historial"
    // (eso pasa recién en guardarTurno, después de tener la respuesta), así
    // que lo agregamos acá al final de la lista para esta llamada puntual.
    messages: [...historial, { role: 'user', content: textoUsuario }],
    maxOutputTokens: 1024,
  });

  guardarTurno(jid, textoUsuario, text);
  return text;
}

// ---------------------------------------------------------------------------
// Manejo de un mensaje entrante
// ---------------------------------------------------------------------------

async function manejarMensaje(sock, jid, textoUsuario) {
  try {
    // sendPresenceUpdate('composing', jid) hace que WhatsApp muestre
    // "escribiendo..." en el chat del usuario mientras esperamos la
    // respuesta del LLM, para que no parezca que el bot no responderá.
    await sock.sendPresenceUpdate('composing', jid);

    // llamarLLM ya se encarga de leer el historial de este jid y de
    // guardar el turno completo (usuario + respuesta) al terminar.
    const respuestaTexto = await llamarLLM(jid, textoUsuario);

    // 'paused' apaga el indicador de "escribiendo..." antes de mandar el
    // mensaje real; si no lo hacemos, WhatsApp lo deja parpadeando un rato.
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text: respuestaTexto });
  } catch (error) {
    console.error(`Error respondiendo a ${jid}:`, error.message);
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

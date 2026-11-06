// sesiones.js — hash de contraseñas, token de sesión firmado y demora por
// intentos fallidos. Solo usa WebCrypto (nativo en Workers): sin dependencias.
// S0 lo usa establecerClaveUsuario; desde S1 lo usan validarLogin e index.js.

// Workers rechaza PBKDF2 con más de 100.000 iteraciones. Cada cuenta guarda
// las suyas, así que el valor se puede cambiar sin romper las existentes.
export const ITERACIONES_PBKDF2 = 100000;

// Roles que tienen cuenta en `usuarios` (el operario entra solo con cédula).
// Se valida aquí y no con CHECK en la tabla, para poder sumar roles después.
export const ROLES_CON_CLAVE = ["supervisor", "planeacion"];

// Duración de la sesión por rol, en segundos.
export const DURACION_SESION_SEG = {
  operario: 12 * 3600,
  supervisor: 8 * 3600,
  planeacion: 8 * 3600,
};

const DEMORA_MAX_SEG = 10; // techo de demora tras intentos fallidos repetidos
const DECAY_MS = 60 * 60 * 1000; // 1 hora sin fallos nuevos = contador reiniciado

const _enc = new TextEncoder();
const _dec = new TextDecoder();

// ---------- base64url ----------

function _aB64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _deB64url(texto) {
  const b64 = String(texto).replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "===".slice((b64.length + 3) % 4));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// Recorre todos los bytes aunque encuentre una diferencia temprano.
function _igualesTiempoConstante(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a[i] ^ b[i];
  return dif === 0;
}

// Compara dos textos sin filtrar su largo ni dónde difieren: compara sus
// SHA-256, que siempre miden 32 bytes.
export async function textosIguales(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", _enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", _enc.encode(String(b))),
  ]);
  return _igualesTiempoConstante(new Uint8Array(ha), new Uint8Array(hb));
}

// ---------- contraseñas ----------

async function _pbkdf2(password, salBytes, iteraciones) {
  const llave = await crypto.subtle.importKey(
    "raw",
    _enc.encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salBytes,
      iterations: iteraciones,
    },
    llave,
    256,
  );
  return new Uint8Array(bits);
}

// Devuelve { hash, sal, iteraciones } listos para guardar en `usuarios`.
export async function hashClave(password) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await _pbkdf2(password, sal, ITERACIONES_PBKDF2);
  return {
    hash: _aB64url(hash),
    sal: _aB64url(sal),
    iteraciones: ITERACIONES_PBKDF2,
  };
}

// fila: { hash, sal, iteraciones } leída de `usuarios`.
export async function verificarClave(password, fila) {
  if (!fila || !fila.hash || !fila.sal || !fila.iteraciones) return false;
  const calculado = await _pbkdf2(
    password,
    _deB64url(fila.sal),
    Number(fila.iteraciones),
  );
  return _igualesTiempoConstante(calculado, _deB64url(fila.hash));
}

// ---------- token de sesión ----------
// Formato: base64url(JSON) + "." + base64url(HMAC-SHA256), con SECRET_SESIONES.
// Contenido: { rol, cedula, nombre, v, exp } (v = usuarios.version; 0 en operario).

async function _llaveHmac(env) {
  const secreto = env.SECRET_SESIONES || "";
  if (secreto.length < 32) {
    throw new Error(
      "SECRET_SESIONES no está configurado (mínimo 32 caracteres).",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    _enc.encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function firmarToken(env, { rol, cedula, nombre, v }) {
  const duracion = DURACION_SESION_SEG[rol];
  if (!duracion) throw new Error("Rol sin duración de sesión: " + rol);
  const exp = Math.floor(Date.now() / 1000) + duracion;
  const cuerpo = _aB64url(
    _enc.encode(JSON.stringify({ rol, cedula, nombre, v: v || 0, exp })),
  );
  const firma = await crypto.subtle.sign(
    "HMAC",
    await _llaveHmac(env),
    _enc.encode(cuerpo),
  );
  return {
    token: cuerpo + "." + _aB64url(new Uint8Array(firma)),
    exp,
    duracion,
  };
}

// Devuelve el contenido del token si la firma es válida y no venció; si no,
// null. No consulta D1: la versión y el estado de la cuenta los revisa quien
// llama (S1), solo para los roles con clave.
export async function verificarToken(env, token) {
  const partes = String(token || "").split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  let valida;
  try {
    valida = await crypto.subtle.verify(
      "HMAC",
      await _llaveHmac(env),
      _deB64url(partes[1]),
      _enc.encode(partes[0]),
    );
  } catch (e) {
    return null;
  }
  if (!valida) return null;
  let datos;
  try {
    datos = JSON.parse(_dec.decode(_deB64url(partes[0])));
  } catch (e) {
    return null;
  }
  if (!datos || !DURACION_SESION_SEG[datos.rol]) return null;
  if (!(Number(datos.exp) > Math.floor(Date.now() / 1000))) return null;
  return datos;
}

// ---------- demora por intentos fallidos (tabla intentos_login) ----------
// Llaves con prefijo: "ip:<ip>", "ced:<cedula>", "maestra:<ip>". Las filas
// viejas de validarLogin usan la IP sin prefijo; conviven sin problema.

export async function intentosVigentes(env, llave) {
  const fila = await env.DB.prepare(
    "SELECT intentos, actualizado_en FROM intentos_login WHERE identificador = ?",
  )
    .bind(llave)
    .first();
  if (!fila) return 0;
  const vencido =
    Date.now() - new Date(fila.actualizado_en).getTime() > DECAY_MS;
  return vencido ? 0 : fila.intentos;
}

// Suma un fallo a cada llave y espera según el mayor contador. Sin bloqueo
// duro: un bloqueo permitiría dejar sin acceso a un compañero a propósito.
export async function registrarFalloYEsperar(env, llaves) {
  const ahora = new Date().toISOString();
  let mayor = 0;
  for (const llave of llaves) {
    const nuevos = (await intentosVigentes(env, llave)) + 1;
    mayor = Math.max(mayor, nuevos);
    await env.DB.prepare(
      "INSERT INTO intentos_login (identificador, intentos, actualizado_en) VALUES (?, ?, ?) " +
        "ON CONFLICT(identificador) DO UPDATE SET intentos = excluded.intentos, " +
        "actualizado_en = excluded.actualizado_en",
    )
      .bind(llave, nuevos, ahora)
      .run();
  }
  const demoraSeg = Math.min(mayor, DEMORA_MAX_SEG);
  await new Promise((resolve) => setTimeout(resolve, demoraSeg * 1000));
}

export async function borrarIntentos(env, llaves) {
  for (const llave of llaves) {
    await env.DB.prepare("DELETE FROM intentos_login WHERE identificador = ?")
      .bind(llave)
      .run();
  }
}

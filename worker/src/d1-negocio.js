// Helpers de negocio compartidos por las acciones de escritura (submitRegistro,
// submitRegistroOperario, guardarJustificacion). Traducción fiel de code.js.

const TTL_EN_PROCESO_SEG = 120;
const TTL_IDEMPOTENCIA_SEG = 21600; // 6 horas — igual al tope que ya usaba CacheService

async function _sha256Hex(texto) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(texto),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function _huellaPayload(accion, payload) {
  const datosOrdenados = {};
  Object.keys(payload)
    .sort()
    .forEach((key) => {
      let valor = payload[key];
      if (Array.isArray(valor)) valor = [...valor].sort();
      datosOrdenados[key] = valor;
    });
  return (
    "idem_" + (await _sha256Hex(accion + "|" + JSON.stringify(datosOrdenados)))
  );
}

// Reemplaza CacheService+LockService: el PRIMARY KEY de "idempotencia" hace de
// reserva atómica — si dos envíos idénticos llegan casi juntos, el segundo INSERT
// choca contra el primero sin necesidad de un lock explícito.
export async function _chequearIdempotencia(env, huella) {
  const ahora = Date.now();
  await env.DB.prepare(
    "DELETE FROM idempotencia WHERE huella = ? AND expira_en < ?",
  )
    .bind(huella, String(ahora))
    .run();

  try {
    await env.DB.prepare(
      "INSERT INTO idempotencia (huella, respuesta, expira_en) VALUES (?, '__EN_PROCESO__', ?)",
    )
      .bind(huella, String(ahora + TTL_EN_PROCESO_SEG * 1000))
      .run();
    return { duplicado: false, enProceso: false };
  } catch (err) {
    const existente = await env.DB.prepare(
      "SELECT respuesta FROM idempotencia WHERE huella = ?",
    )
      .bind(huella)
      .first();
    if (!existente) throw err;
    if (existente.respuesta === "__EN_PROCESO__")
      return { duplicado: false, enProceso: true };
    return { duplicado: true, respuesta: JSON.parse(existente.respuesta) };
  }
}

export async function _confirmarIdempotencia(env, huella, respuesta) {
  await env.DB.prepare(
    "UPDATE idempotencia SET respuesta = ?, expira_en = ? WHERE huella = ?",
  )
    .bind(
      JSON.stringify(respuesta),
      String(Date.now() + TTL_IDEMPOTENCIA_SEG * 1000),
      huella,
    )
    .run();
}

export async function _liberarIdempotencia(env, huella) {
  await env.DB.prepare("DELETE FROM idempotencia WHERE huella = ?")
    .bind(huella)
    .run();
}

export async function _validarSupervisorYSupernumerario(
  env,
  coordinadorEscrito,
  supernumerarioEscrito,
) {
  if (!coordinadorEscrito) throw new Error("Falta el nombre del coordinador.");
  if (!supernumerarioEscrito)
    throw new Error("Falta el nombre del supernumerario.");

  const coord = await env.DB.prepare(
    "SELECT nombre FROM supervisores WHERE tipo = 'coordinador' AND lower(nombre) = lower(?)",
  )
    .bind(coordinadorEscrito)
    .first();
  if (!coord)
    throw new Error(
      'El coordinador "' +
        coordinadorEscrito +
        '" no existe en el catálogo de supervisores.',
    );

  const supernum = await env.DB.prepare(
    "SELECT nombre FROM supervisores WHERE tipo = 'supernumerario' AND lower(nombre) = lower(?)",
  )
    .bind(supernumerarioEscrito)
    .first();
  if (!supernum)
    throw new Error(
      'El supernumerario "' +
        supernumerarioEscrito +
        '" no existe en el catálogo de supervisores.',
    );

  return { coordinador: coord.nombre, supernumerario: supernum.nombre };
}

export async function _localizarValidacionEan(env, pedido, ean) {
  const row = await env.DB.prepare(
    "SELECT sublinea, unidades_totales, unidades_procesadas, codigos_sobrantes, " +
      "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones WHERE pedido = ? AND ean = ?) AS justificado " +
      "FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?",
  )
    .bind(pedido, ean, pedido, ean)
    .first();
  if (!row)
    throw new Error(
      "El pedido " +
        pedido +
        " con el EAN " +
        ean +
        " no existe en la hoja de Validación.",
    );
  return row;
}

export async function _obtenerDatosPedido(env, pedido, sublinea) {
  const row = await env.DB.prepare(
    "SELECT cliente, evento, clasificacion_proceso AS clasificacionProceso FROM pedidos " +
      "WHERE numero_pedido = ? AND sublinea = ?",
  )
    .bind(pedido, sublinea)
    .first();
  if (!row) {
    throw new Error(
      "El pedido " +
        pedido +
        ' con la sublínea "' +
        sublinea +
        '" no está registrado en Numero pedidos. Verifica que exista esa combinación exacta.',
    );
  }
  return row;
}

export async function _obtenerProcesoValidado(env, nombreProceso, pedido) {
  const nombre = String(nombreProceso || "").trim();
  if (!nombre) throw new Error("Falta seleccionar el proceso.");
  const row = await env.DB.prepare(
    "SELECT nombre_proceso AS nombre, unidades_hora_estandar AS unidadesHora FROM procesos " +
      "WHERE lower(nombre_proceso) = lower(?) AND numero_pedido = ?",
  )
    .bind(nombre, pedido)
    .first();
  if (!row)
    throw new Error(
      'El proceso "' +
        nombre +
        '" no existe o no está asignado al pedido ' +
        pedido +
        ".",
    );
  return row;
}

export async function _buscarCedulaPorNombre(env, nombre) {
  const row = await env.DB.prepare(
    "SELECT cedula FROM operarios WHERE lower(nombre_operario) = lower(?)",
  )
    .bind(nombre)
    .first();
  return row ? row.cedula : "";
}

// Equivalente a _marcarPedidoIniciado: la primera vez que un pedido recibe un
// registro, inicializa a 'Pendiente' los EANes que aún estén en blanco.
export async function _marcarPedidoIniciado(env, pedido, ahora) {
  const resultado = await env.DB.prepare(
    "UPDATE validacion_eanes SET estado = 'Pendiente', actualizado_en = ? " +
      "WHERE numero_pedido = ? AND (estado IS NULL OR estado = '')",
  )
    .bind(ahora, pedido)
    .run();

  if (resultado.meta.changes > 0) {
    await env.DB.prepare(
      "INSERT INTO control_produccion (numero_pedido, estado, actualizado_en) VALUES (?, 'En proceso', ?) " +
        "ON CONFLICT(numero_pedido) DO UPDATE SET estado = 'En proceso', actualizado_en = excluded.actualizado_en",
    )
      .bind(pedido, ahora)
      .run();
  }
}

export async function _pedidoEstaCompleto(env, pedido) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN estado != 'Completado' THEN 1 ELSE 0 END) AS pendientes " +
      "FROM validacion_eanes WHERE numero_pedido = ?",
  )
    .bind(pedido)
    .first();
  return row.total > 0 && row.pendientes === 0;
}

export function _duracionMinutos(horaInicio, horaFin) {
  const [h1, m1] = String(horaInicio).split(":").map(Number);
  const [h2, m2] = String(horaFin).split(":").map(Number);
  let minutos = h2 * 60 + m2 - (h1 * 60 + m1);
  if (minutos < 0) minutos += 24 * 60;
  return minutos;
}

export function _calcularDuracionValidada(horaInicio, horaFin, suplementoMin) {
  const duracionBrutaMin = _duracionMinutos(horaInicio, horaFin);
  if (duracionBrutaMin <= 0)
    throw new Error("La hora de fin debe ser posterior a la hora de inicio.");
  const duracionRealMin = duracionBrutaMin - suplementoMin;
  if (duracionRealMin <= 0)
    throw new Error(
      "El suplemento no puede ser mayor o igual al tiempo trabajado.",
    );
  return { duracionBrutaMin, duracionRealMin };
}

export function _calcularMetricasProduccion(
  unidadesOperario,
  tasaEstandarOperario,
  durHoras,
) {
  const esperado = tasaEstandarOperario * durHoras;
  const unidadesHoraReal =
    durHoras > 0 ? Math.round((unidadesOperario / durHoras) * 100) / 100 : 0;
  const eficiencia =
    esperado > 0 ? Math.round((unidadesOperario / esperado) * 100) : 0;
  return { unidadesHoraReal, eficiencia };
}

export function _validarCodigosSobrantes(valor) {
  if (valor === undefined || valor === null || valor === "") return 0;
  const num = Number(valor);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(
      "Los códigos sobrantes deben ser un número entero mayor o igual a 0 (sin decimales).",
    );
  }
  return num;
}

export function _fechaHoyBogota() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function _ahoraISO() {
  return new Date().toISOString();
}

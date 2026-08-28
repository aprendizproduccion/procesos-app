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
    "SELECT cedula FROM operarios WHERE lower(nombre_operario) = lower(?) AND activo = 1",
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

// Complementa _pedidoEstaCompleto: además de poder CERRAR un pedido (lo que ya
// hacían submitRegistro/submitRegistroOperario/guardarJustificacion de forma
// inline), esta función también puede REABRIRLO si una edición o anulación hizo
// que ya no esté completo. Se usa solo desde edición/anulación de registros —
// los tres flujos de envío normales siguen con su bloque inline, sin cambios.
export async function _sincronizarEstadoPedido(env, pedido) {
  const completo = await _pedidoEstaCompleto(env, pedido);
  const ahora = _ahoraISO();
  await env.DB.prepare(
    "INSERT INTO control_produccion (numero_pedido, estado, actualizado_en) VALUES (?, ?, ?) " +
      "ON CONFLICT(numero_pedido) DO UPDATE SET estado = excluded.estado, actualizado_en = excluded.actualizado_en",
  )
    .bind(pedido, completo ? "Completado" : "En proceso", ahora)
    .run();
  return completo;
}

// Revierte una reserva de unidades ya aplicada, para cuando el INSERT de
// registros falla DESPUÉS de que la reserva ya comprometió cambios en D1.
export async function _revertirReserva(
  env,
  { pedido, ean, total, codigosSobrantes },
) {
  await env.DB.prepare(
    "UPDATE validacion_eanes SET " +
      "unidades_procesadas = unidades_procesadas - ?, " +
      "codigos_sobrantes = codigos_sobrantes - ?, " +
      "estado = CASE WHEN (unidades_procesadas - ? - codigos_sobrantes - ?) >= unidades_totales " +
      "THEN 'Completado' ELSE 'En proceso' END " +
      "WHERE numero_pedido = ? AND ean_producto = ?",
  )
    .bind(total, codigosSobrantes, total, codigosSobrantes, pedido, ean)
    .run();
}

// Revierte un cierre de EAN ya aplicado, para cuando el INSERT de la
// justificación falla DESPUÉS de que el cierre ya comprometió cambios en D1.
export async function _revertirCierre(env, pedido, ean) {
  await env.DB.prepare(
    "UPDATE validacion_eanes SET estado = 'En proceso' WHERE numero_pedido = ? AND ean_producto = ?",
  )
    .bind(pedido, ean)
    .run();
}

// Reconstruye el contador de validacion_eanes desde la fuente real (registros +
// justificaciones) en una sola sentencia atómica, en vez de sumar/restar un
// delta a mano. Excluye registros anulados. Se usa SOLO desde edición/anulación
// de registros — submitRegistro, submitRegistroOperario y guardarJustificacion
// NO se tocan ni usan esta función; su reserva atómica sigue exactamente igual.
export async function _recalcularContadorValidacion(env, pedido, ean) {
  const ahora = _ahoraISO();
  await env.DB.prepare(
    "WITH agregados AS (" +
      "SELECT COALESCE(SUM(unidades_procesadas_operario),0) AS procesado, " +
      "COALESCE(SUM(codigos_sobrantes),0) AS sobrantes " +
      "FROM registros WHERE numero_pedido = ? AND ean = ? AND anulado = 0" +
      "), justif AS (" +
      "SELECT COALESCE(SUM(faltante),0) AS justificado " +
      "FROM justificaciones WHERE pedido = ? AND ean = ?" +
      "), operarios_activos AS (" +
      "SELECT GROUP_CONCAT(nombre, ' - ') AS nombres FROM (" +
      "SELECT DISTINCT operario AS nombre FROM registros " +
      "WHERE numero_pedido = ? AND ean = ? AND anulado = 0)" +
      ") " +
      "UPDATE validacion_eanes SET " +
      "unidades_procesadas = (SELECT procesado FROM agregados), " +
      "codigos_sobrantes = (SELECT sobrantes FROM agregados), " +
      "operarios = COALESCE((SELECT nombres FROM operarios_activos), ''), " +
      "estado = CASE " +
      "WHEN ((SELECT procesado FROM agregados) + (SELECT sobrantes FROM agregados) + (SELECT justificado FROM justif)) >= unidades_totales THEN 'Completado' " +
      "WHEN ((SELECT procesado FROM agregados) + (SELECT sobrantes FROM agregados) + (SELECT justificado FROM justif)) <= 0 THEN 'Pendiente' " +
      "ELSE 'En proceso' END, " +
      "actualizado_en = ? " +
      "WHERE numero_pedido = ? AND ean_producto = ?",
  )
    .bind(pedido, ean, pedido, ean, pedido, ean, ahora, pedido, ean)
    .run();
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

// formatToParts en vez de .format() para controlar el orden exacto del string
// y no depender de cómo el runtime arme el formato "en-CA" con hora incluida.
// Acepta una fecha/ISO opcional para reformatear un valor ya guardado en D1
// (anulado_en/editado_en); sin argumento, formatea "ahora" igual que antes.
export function _fechaHoraBogota(fecha) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(fecha ? new Date(fecha) : new Date());

  const obtener = (tipo) => partes.find((p) => p.type === tipo).value;
  return (
    obtener("year") +
    "-" +
    obtener("month") +
    "-" +
    obtener("day") +
    " " +
    obtener("hour") +
    ":" +
    obtener("minute")
  );
}

export function _ahoraISO() {
  return new Date().toISOString();
}

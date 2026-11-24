// Acciones del rol Planeación: los módulos que reemplazan las hojas de
// catálogo. Todas van en PERMISOS_POR_ACCION de index.js como ["planeacion"]:
// exigen esa sesión también en modo mixto.
// F2a (solo lectura): Pedidos y Clientes.
// F2b-1: crear y eliminar pedidos, y crear/desactivar/reactivar clientes. Las
// escrituras exigen el interruptor (_exigirCatalogoEnApp): hasta el corte F4
// quedan bloqueadas y las hojas siguen mandando.
// F2b-2: editar pedido (cliente, evento, clasificación, sublíneas y procesos;
// el número y la fecha no se editan).
// F3a: EAN de un pedido (Validación eanes) en solo lectura, y el aviso cuando
// la suma de sus EAN no coincide con las unidades pedidas.
// F3b: agregar, editar y eliminar un EAN (con el interruptor, como F2b) y
// "Corregir" su contador desde los registros (sin interruptor: el contador es
// de D1 y la hoja solo lo recibe por el espejo).
// F3c: pegar varios EAN desde Excel con vista previa y guardado todo o nada
// (cargarEanes: la vista previa funciona ya; guardar exige el interruptor).
// F5 · P2: los procesos de un pedido salen del catálogo de procesos
// (catalogo_procesos, módulo Procesos en acciones-procesos.js).

import {
  _normalizarPedido,
  _exigirCatalogoEnApp,
  _huellaPayload,
  _chequearIdempotencia,
  _confirmarIdempotencia,
  _liberarIdempotencia,
  _fechaHoyBogota,
  _ahoraISO,
  _actualizarSeguimientoPedido,
  _sqlEanReferente,
  _formasEan,
  _esEanReferente,
  _estadoContador,
  _sentenciaRecalcularContador,
  _sincronizarEstadoPedido,
} from "./d1-negocio.js";
import { _pushSeguimientoYMarcar } from "./push-sheets.js";

// Procesos sin estándar que llevan casi todos los pedidos. Desde F5 · P2 el
// formulario preselecciona los que tienen la marca "general" en el catálogo;
// esta lista solo pone esa marca al agregar los procesos en uso (agregarEnUso).
export const PROCESOS_GENERALES = [
  "Induccion Proceso",
  "Pasar Trabajo",
  "Sin Estandar",
  "Cambio de proceso",
  "Apoyo Supernumerarios",
];

const MAX_SUBLINEAS = 20;
const MAX_PROCESOS = 40;
const MAX_UNIDADES_PEDIDO = 10000000;
const MAX_LARGO_EAN = 30;

// Listas fijas de "Numero pedidos". El frontend las recibe de aquí para usar
// exactamente las mismas; F2b validará contra ellas.
export const EVENTOS_PEDIDO = ["Linea", "Moda", "Ninguna"];
export const CLASIFICACIONES_PEDIDO = [
  "Ninguna",
  "Adelanto",
  "Pedido",
  "Calidad",
  "Inventario",
  "Picking",
  "Reposición",
  "Procesos Internos",
];

// Mayúsculas, tildes y espacios no cuentan como valor distinto.
function _enLista(valor, lista) {
  const clave = _normalizarPedido(valor);
  return lista.some((v) => _normalizarPedido(v) === clave);
}

function _distintos(lista) {
  return [...new Set(lista)];
}

// Espacios de más fuera; el texto se guarda tal cual, sin normalizar.
function _limpiar(texto) {
  return String(texto || "")
    .trim()
    .replace(/\s+/g, " ");
}

// true si todos los catálogos están en la app. Solo informa al frontend: la
// autoridad es _exigirCatalogoEnApp en cada escritura.
async function _edicionHabilitada(env, claves) {
  try {
    for (const clave of claves) await _exigirCatalogoEnApp(env, clave);
    return true;
  } catch (err) {
    return false;
  }
}

// Inicial de un proceso para el número del pedido: primera letra A-Z del
// nombre en mayúsculas y sin tildes ("Ñ" cuenta como "N").
function _inicialProceso(nombre) {
  const m = String(nombre || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .match(/[A-Z]/);
  return m ? m[0] : "";
}

// Catálogo de procesos (F5): la tabla catalogo_procesos por su clave (nombre
// sin tildes, mayúsculas ni espacios). Desde P2 los pedidos toman de aquí el
// nombre, el estándar y el link de cada proceso.
async function _catalogoProcesos(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, nombre, clave, estandar, link, general, activo FROM catalogo_procesos",
  ).all();
  const catalogo = new Map();
  results.forEach((r) =>
    catalogo.set(String(r.clave), {
      id: r.id,
      nombre: String(r.nombre),
      estandar: Number(r.estandar) || 0,
      link: String(r.link || ""),
      general: r.general === 1,
      activo: r.activo === 1,
    }),
  );
  return catalogo;
}

// Guarda de los procesos del catálogo que se escriben en un pedido: se cumple
// si entre la lectura y el batch alguno se desactivó, se eliminó o cambió su
// nombre, su estándar o su link (lo escrito sería distinto del catálogo).
function _guardaCatalogo(procesos) {
  return {
    condicion:
      "(SELECT COUNT(*) FROM json_each(?) j JOIN catalogo_procesos c " +
      "ON c.id = json_extract(j.value, '$.id') AND c.activo = 1 " +
      "AND c.nombre = json_extract(j.value, '$.nombre') " +
      "AND c.estandar = json_extract(j.value, '$.estandar') " +
      "AND c.link = json_extract(j.value, '$.link')) < ?",
    binds: [
      JSON.stringify(
        procesos.map((p) => ({
          id: p.id,
          nombre: p.nombre,
          estandar: p.estandar,
          link: p.link,
        })),
      ),
      procesos.length,
    ],
  };
}

const MSG_CATALOGO_CAMBIO =
  "Un proceso cambió en el catálogo mientras guardabas (se editó, se desactivó o se eliminó). Vuelve a abrir el formulario.";

// Sublíneas ya usadas, agrupadas por nombre normalizado (gana la escritura más
// usada), de la más usada a la menos.
async function _sublineasUsadas(env) {
  const { results } = await env.DB.prepare(
    "SELECT sublinea, COUNT(*) AS usos FROM pedidos GROUP BY sublinea",
  ).all();
  const grupos = new Map();
  results.forEach((r) => {
    const nombre = String(r.sublinea || "").trim();
    const clave = _normalizarPedido(nombre);
    if (!clave) return;
    const g = grupos.get(clave) || { nombre, mejor: 0, usos: 0 };
    if (r.usos > g.mejor) {
      g.nombre = nombre;
      g.mejor = r.usos;
    }
    g.usos += r.usos;
    grupos.set(clave, g);
  });
  return grupos;
}

// Números de pedido existentes (pedidos y Validación eanes), normalizados.
async function _numerosExistentes(env) {
  const { results } = await env.DB.prepare(
    "SELECT numero_pedido AS pedido FROM pedidos UNION SELECT numero_pedido FROM validacion_eanes",
  ).all();
  return new Set(results.map((r) => _normalizarPedido(r.pedido)));
}

// Número automático: unidades + iniciales de los procesos con estándar (se
// repiten si se repiten). Si ya existe, se agrega 2, 3... al final:
// 2000-TE → 2000-TE2; sin letras, 2000 → 2000-2.
function _numeroAutomatico(unidades, procesos, existentes) {
  const letras = procesos
    .filter((p) => p.estandar > 0)
    .map((p) => _inicialProceso(p.nombre))
    .join("");
  const base = String(unidades) + (letras ? "-" + letras : "");
  if (!existentes.has(_normalizarPedido(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidato = base + (letras ? "" : "-") + n;
    if (!existentes.has(_normalizarPedido(candidato))) return candidato;
  }
  throw new Error("No se pudo generar un número libre para el pedido.");
}

// Guarda del batch: la auditoría lleva hecho_en NULL si `condicionSql` se
// cumple; hecho_en es NOT NULL, así que el INSERT falla y D1 deshace el batch
// completo. `binds` son los parámetros de `condicionSql`.
function _auditoriaConGuarda(env, fila, condicionSql, binds) {
  return env.DB.prepare(
    "INSERT INTO auditoria_catalogos (tabla, llave, accion, antes, despues, cedula, nombre, hecho_en) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, CASE WHEN " +
      condicionSql +
      " THEN NULL ELSE ? END",
  ).bind(
    fila.tabla,
    fila.llave,
    fila.accion,
    fila.antes === undefined ? null : JSON.stringify(fila.antes),
    fila.despues === undefined ? null : JSON.stringify(fila.despues),
    fila.cedula,
    fila.nombre,
    ...binds,
    fila.hechoEn,
  );
}

function _auditoria(env, fila) {
  return _auditoriaConGuarda(env, fila, "0", []);
}

// Un pedido está cerrado si tiene EAN referentes y todos están en Completado
// (mismo criterio que _pedidoEstaCompleto y Seguimiento). Uno sin EAN
// referentes (actividad interna, pedido sin EAN) nunca cierra solo: cuenta
// como abierto. `columna`: expresión SQL con el número de pedido.
function _sqlPedidoAbierto(columna) {
  return (
    "NOT (EXISTS(SELECT 1 FROM validacion_eanes va WHERE va.numero_pedido = " +
    columna +
    " AND " +
    _sqlEanReferente("va.") +
    ") AND NOT EXISTS(SELECT 1 FROM validacion_eanes va WHERE va.numero_pedido = " +
    columna +
    " AND " +
    _sqlEanReferente("va.") +
    " AND COALESCE(va.estado, '') <> 'Completado'))"
  );
}

// Cada pedido con su cliente y si sigue abierto. Un pedido con sublíneas de
// clientes distintos sale una vez por cliente.
function _sqlPedidosPorCliente() {
  return (
    "SELECT DISTINCT p.numero_pedido AS pedido, p.cliente, CASE WHEN " +
    _sqlPedidoAbierto("p.numero_pedido") +
    " THEN 1 ELSE 0 END AS abierto FROM pedidos p"
  );
}

function _redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Aviso de F3: los EAN que cuentan para el cierre no suman las unidades que
// pidió el cliente. Sin unidades pedidas (pedidos de la hoja que no las tienen)
// no hay con qué comparar. Lo usan la lista de Pedidos y la vista de EAN.
function _alertaSumaEan(unidadesEan, unidadesPedidas) {
  const suma = _redondear2(unidadesEan);
  if (!unidadesPedidas || suma === unidadesPedidas) return "";
  return (
    "Los EAN suman " +
    suma +
    " unidades y el pedido pide " +
    unidadesPedidas +
    "."
  );
}

// Un proceso que se agrega a un pedido (F5 · P2): se busca en el catálogo por
// su nombre normalizado y debe estar activo. Nombre, estándar y link son los
// del catálogo; lo que mande el navegador no cuenta. La repetición dentro del
// pedido la revisa quien llama.
function _procesoDelCatalogo(p, catalogo) {
  const texto = _limpiar(p && p.nombre);
  const clave = _normalizarPedido(texto);
  if (!clave) throw new Error("Hay un proceso sin nombre.");
  const c = catalogo.get(clave);
  if (!c)
    throw new Error(
      'El proceso "' +
        texto +
        '" no está en el catálogo: créalo primero en el módulo Procesos.',
    );
  if (!c.activo)
    throw new Error(
      'El proceso "' +
        c.nombre +
        '" está inactivo en el catálogo: reactívalo en el módulo Procesos o elige otro.',
    );
  return { clave, ...c };
}

// Valor de una lista fija. Si equivale al que ya tiene el pedido (y no difiere
// entre sublíneas), se conserva su escritura para no reescribir registros por
// una mayúscula.
function _valorDeLista(valor, lista, actual, difiere, mensaje) {
  const elegido = lista.find(
    (v) => _normalizarPedido(v) === _normalizarPedido(valor),
  );
  if (!elegido) throw new Error(mensaje);
  return !difiere && _normalizarPedido(actual) === _normalizarPedido(elegido)
    ? actual
    : elegido;
}

// Estado actual de un pedido para editarlo: sus filas de pedidos, sus
// procesos, cuántos EAN tiene cada sublínea y cuántos registros (anulados
// incluidos) cada proceso. La huella resume filas y procesos: si cambia entre
// abrir el formulario y guardar, alguien más editó el pedido.
async function _estadoPedido(env, pedido) {
  const { results: filas } = await env.DB.prepare(
    "SELECT sublinea, cliente, evento, clasificacion_proceso AS clasificacion, fecha, " +
      "unidades_pedidas AS unidades FROM pedidos WHERE numero_pedido = ? ORDER BY sublinea",
  )
    .bind(pedido)
    .all();
  const { results: procesos } = await env.DB.prepare(
    "SELECT nombre_proceso AS nombre, unidades_hora_estandar AS estandar, " +
      "COALESCE(link_procesos, '') AS link FROM procesos WHERE numero_pedido = ? ORDER BY id",
  )
    .bind(pedido)
    .all();
  const { results: eanes } = await env.DB.prepare(
    "SELECT sublinea, COUNT(*) AS n FROM validacion_eanes WHERE numero_pedido = ? GROUP BY sublinea",
  )
    .bind(pedido)
    .all();
  const { results: usos } = await env.DB.prepare(
    "SELECT proceso, COUNT(*) AS n FROM registros WHERE numero_pedido = ? GROUP BY proceso",
  )
    .bind(pedido)
    .all();
  // Un pedido creado en la app ya nació con sus unidades (o es una actividad
  // interna): sus unidades pedidas no se editan.
  const creado = await env.DB.prepare(
    "SELECT 1 AS si FROM auditoria_catalogos WHERE tabla = 'pedidos' AND llave = ? " +
      "AND accion = 'crear' LIMIT 1",
  )
    .bind(pedido)
    .first();

  const _contar = (lista, campo) => {
    const m = new Map();
    lista.forEach((x) => {
      const clave = _normalizarPedido(x[campo]);
      m.set(clave, (m.get(clave) || 0) + x.n);
    });
    return m;
  };
  const eanesPorSub = _contar(eanes, "sublinea");
  const registrosPorProc = _contar(usos, "proceso");

  const filasLimpias = filas.map((f) => ({
    sublinea: String(f.sublinea),
    cliente: String(f.cliente || ""),
    evento: String(f.evento || ""),
    clasificacion: String(f.clasificacion || ""),
    fecha: String(f.fecha || ""),
    unidades: Number(f.unidades) || 0,
  }));
  const procesosLimpios = procesos.map((p) => ({
    nombre: String(p.nombre),
    estandar: Number(p.estandar) || 0,
    link: String(p.link || "").trim(),
  }));
  const base = filasLimpias[0] || {};
  const difiere = (campo) =>
    _distintos(filasLimpias.map((f) => f[campo])).length > 1;
  const unidadesPedidas = Math.max(0, ...filasLimpias.map((f) => f.unidades));

  return {
    existe: filasLimpias.length > 0,
    soloEnValidacion: filasLimpias.length === 0 && eanes.length > 0,
    filas: filasLimpias,
    cliente: base.cliente || "",
    evento: base.evento || "",
    clasificacion: base.clasificacion || "",
    difieren: {
      cliente: difiere("cliente"),
      evento: difiere("evento"),
      clasificacion: difiere("clasificacion"),
    },
    fecha:
      filasLimpias
        .map((f) => f.fecha)
        .filter(Boolean)
        .sort()[0] || "",
    unidadesPedidas,
    unidadesEditables: !creado && unidadesPedidas === 0,
    sublineas: filasLimpias.map((f) => ({
      sublinea: f.sublinea,
      eanes: eanesPorSub.get(_normalizarPedido(f.sublinea)) || 0,
    })),
    procesos: procesosLimpios.map((p) => ({
      ...p,
      registros: registrosPorProc.get(_normalizarPedido(p.nombre)) || 0,
    })),
    huella: await _huellaPayload("estadoPedido", {
      estado: JSON.stringify({
        filas: filasLimpias,
        procesos: procesosLimpios,
      }),
    }),
  };
}

function _errorPedidoNoEditable(pedido, estado) {
  return new Error(
    estado.soloEnValidacion
      ? "El pedido " +
          pedido +
          ' solo existe en Validación eanes: corrígelo en la hoja "Numero pedidos" antes del corte.'
      : "El pedido " + pedido + " no existe.",
  );
}

// ---------------- Pedidos por etapas (24-11) ----------------
// Un pedido por etapas es de referencia única: cada proceso que cuenta
// unidades es una etapa, con su fila en Validación eanes (código ETAPA1,
// ETAPA2..., en procesos.etapa_ean) y la meta en las unidades pedidas. Los
// procesos que no cuentan se registran en el EAN 0 sin límite. Esas filas las
// maneja la app: sus EAN no se agregan, editan ni eliminan a mano.
const PREFIJO_ETAPA = "ETAPA";
const MSG_PEDIDO_ETAPAS_EAN =
  "Es un pedido por etapas: sus filas de unidades las maneja la app. Aquí no se agregan, editan ni eliminan EAN.";
const MSG_PEDIDO_ETAPAS_EDITAR =
  "Editar un pedido por etapas todavía no está disponible. Si tiene un error y no tiene registros, elimínalo y créalo de nuevo.";

async function _esPedidoPorEtapas(env, pedido) {
  const fila = await env.DB.prepare(
    "SELECT 1 AS si FROM pedidos WHERE numero_pedido = ? AND tipo = 'etapas' LIMIT 1",
  )
    .bind(pedido)
    .first();
  return !!fila;
}

// ---------------- F3b: escribir en los EAN de un pedido ----------------

// EAN tal como se escribió o escaneó: sin espacios, máximo 30 caracteres, y
// el EAN 0 siempre como "0".
function _eanValidado(texto) {
  const ean = String(texto == null ? "" : texto).trim();
  if (!ean) throw new Error("Escribe o escanea el EAN.");
  if (/\s/.test(ean)) throw new Error("El EAN no puede tener espacios.");
  if (ean.length > MAX_LARGO_EAN)
    throw new Error("El EAN pasa de " + MAX_LARGO_EAN + " caracteres.");
  if (/^0+$/.test(ean) && ean !== "0")
    throw new Error('El EAN 0 se escribe "0", sin más ceros.');
  return ean;
}

// Dos EAN son el mismo si coinciden en alguna de sus dos formas (con y sin el
// 0 del preámbulo UPC-A) sin distinguir mayúsculas. El envío busca el texto
// exacto, así que esas variantes no pueden convivir en un pedido.
function _mismoEan(a, b) {
  const claves = _formasEan(a).map((f) => f.toUpperCase());
  return _formasEan(b).some((f) => claves.includes(f.toUpperCase()));
}

// Lo que necesitan las escrituras de F3b. Bloquea los pedidos que solo están
// en Validación eanes (se corrigen en la hoja) y los que tienen justificación
// (decisión del 17-11: la justificación ya no cuadraría). Lo ocupado sale de
// los registros activos, igual que el recálculo del contador.
async function _estadoEanesPedido(env, pedido) {
  const { results: filasPedido } = await env.DB.prepare(
    "SELECT sublinea FROM pedidos WHERE numero_pedido = ?",
  )
    .bind(pedido)
    .all();
  const { results: filas } = await env.DB.prepare(
    "SELECT v.ean_producto AS ean, v.sublinea, v.unidades_totales AS totales, " +
      "v.sin_limite AS sinLimite, COALESCE(v.estado, '') AS estado, " +
      "v.unidades_procesadas AS procesadas, v.codigos_sobrantes AS sobrantes, " +
      "(SELECT COUNT(*) FROM registros r WHERE r.numero_pedido = v.numero_pedido " +
      "AND r.ean = v.ean_producto) AS registros, " +
      "(SELECT COALESCE(SUM(r.unidades_procesadas_operario), 0) FROM registros r " +
      "WHERE r.numero_pedido = v.numero_pedido AND r.ean = v.ean_producto AND r.anulado = 0) AS procesadoReg, " +
      "(SELECT COALESCE(SUM(r.codigos_sobrantes), 0) FROM registros r " +
      "WHERE r.numero_pedido = v.numero_pedido AND r.ean = v.ean_producto AND r.anulado = 0) AS sobrantesReg, " +
      "(SELECT COALESCE(SUM(j.faltante), 0) FROM justificaciones j " +
      "WHERE j.pedido = v.numero_pedido AND j.ean = v.ean_producto) AS justificado " +
      "FROM validacion_eanes v WHERE v.numero_pedido = ?",
  )
    .bind(pedido)
    .all();
  const just = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM justificaciones WHERE pedido = ?",
  )
    .bind(pedido)
    .first();

  if (filasPedido.length === 0)
    throw new Error(
      filas.length
        ? "El pedido " +
            pedido +
            ' solo existe en Validación eanes: corrígelo en la hoja "Numero pedidos" antes del corte.'
        : "El pedido " + pedido + " no existe.",
    );
  if (just.n > 0)
    throw new Error(
      "El pedido " +
        pedido +
        " se cerró con justificación: sus EAN quedan en solo lectura.",
    );

  return {
    sublineas: _distintos(filasPedido.map((f) => String(f.sublinea))),
    eanes: filas.map((f) => {
      const procesadoReg = Number(f.procesadoReg) || 0;
      const sobrantesReg = Number(f.sobrantesReg) || 0;
      const justificado = Number(f.justificado) || 0;
      return {
        ean: String(f.ean),
        sublinea: String(f.sublinea || ""),
        totales: Number(f.totales) || 0,
        sinLimite: f.sinLimite === 1,
        estado: String(f.estado),
        procesadas: Number(f.procesadas) || 0,
        sobrantes: Number(f.sobrantes) || 0,
        registros: Number(f.registros) || 0,
        procesadoReg,
        sobrantesReg,
        ocupado: procesadoReg + sobrantesReg + justificado,
      };
    }),
  };
}

// Mismo criterio que _pedidoEstaCompleto: tiene EAN referentes y todos están
// en Completado (un estado vacío cuenta como abierto).
function _pedidoCerrado(eanes) {
  const referentes = eanes.filter((e) =>
    _esEanReferente(e.ean, e.sinLimite, e.totales),
  );
  return (
    referentes.length > 0 && referentes.every((e) => e.estado === "Completado")
  );
}

// "cierra", "reabre" o "" al pasar de un estado del pedido al otro.
function _efectoCierre(antes, despues) {
  if (antes === despues) return "";
  return despues ? "cierra" : "reabre";
}

// Después de escribir: estado del pedido y su fila de "Seguimiento paquetes".
// Si algo falla aquí, el cambio del EAN ya quedó; el cron de Seguimiento pone
// la fila al día. Devuelve si el pedido quedó cerrado, o null si falló.
async function _trasCambioEan(env, ctx, pedido) {
  try {
    const completo = await _sincronizarEstadoPedido(env, pedido);
    if (await _actualizarSeguimientoPedido(env, pedido, completo))
      ctx.waitUntil(_pushSeguimientoYMarcar(env, pedido));
    return completo;
  } catch (err) {
    console.error(
      "F3b: no se actualizó el estado del pedido " +
        pedido +
        ": " +
        err.message,
    );
    return null;
  }
}

// El batch falló: si fue por la guarda, el pedido cambió entre la lectura y
// la escritura.
async function _errorBatchEan(env, errLote, condicion, binds, mensajeUnico) {
  const guarda = await env.DB.prepare(
    "SELECT CASE WHEN " + condicion + " THEN 1 ELSE 0 END AS bloqueado",
  )
    .bind(...binds)
    .first();
  if (guarda && guarda.bloqueado === 1)
    return new Error(
      "El pedido cambió mientras hacías el cambio (llegaron registros, se justificó o alguien más editó el EAN). Vuelve a abrirlo.",
    );
  if (mensajeUnico && /UNIQUE/i.test(String(errLote && errLote.message)))
    return new Error(mensajeUnico);
  return errLote;
}

// ---------------- F3c: pegar EAN desde Excel ----------------

const MAX_FILAS_CARGA = 300;
const MAX_LARGO_CARGA = 100000;

// Unidades pegadas: entero sin separadores o con puntos de miles exactos
// ("1.200", "12.500"). La coma es decimal en Colombia: no se acepta. Devuelve
// el número, "" si la celda está vacía o null si no se entiende.
function _unidadesPegadas(texto) {
  const valor = String(texto == null ? "" : texto).trim();
  if (!valor) return "";
  if (/^\d+$/.test(valor)) return Number(valor);
  if (/^\d{1,3}(\.\d{3})+$/.test(valor))
    return Number(valor.replace(/\./g, ""));
  return null;
}

// Una línea pegada en celdas: Excel copia con tabuladores; también se acepta
// punto y coma, o espacios si no hay ninguno de los dos (escrito a mano: la
// sublínea es lo que queda después del EAN y las unidades).
function _celdasLinea(linea) {
  if (linea.includes("\t")) return linea.split("\t").map((c) => c.trim());
  if (linea.includes(";")) return linea.split(";").map((c) => c.trim());
  const partes = linea.trim().split(/\s+/);
  return partes.length > 2
    ? [partes[0], partes[1], partes.slice(2).join(" ")]
    : partes;
}

// Si la primera línea es un encabezado (tiene una columna de EAN y otra de
// unidades), dice en qué columna está cada dato. Entre varias columnas de
// unidades manda la de "totales" (la hoja Validacion eanes tiene varias). Las
// demás columnas se ignoran, salvo la de pedido, que debe ser este pedido.
function _columnasCarga(celdas) {
  const columnas = {};
  celdas.forEach((celda, i) => {
    const t = _normalizarPedido(celda);
    let campo = "";
    if (t.includes("ean")) campo = "ean";
    else if (t.includes("sublinea")) campo = "sublinea";
    else if (t.includes("unidad") || t.includes("cantidad")) campo = "unidades";
    else if (t.includes("pedido")) campo = "pedido";
    if (!campo) return;
    if (
      columnas[campo] === undefined ||
      (campo === "unidades" && t.includes("total"))
    )
      columnas[campo] = i;
  });
  return columnas.ean !== undefined && columnas.unidades !== undefined
    ? columnas
    : null;
}

// Lee el texto pegado y revisa cada fila con las reglas de guardarEan, sin
// escribir. Sin encabezado, el orden es EAN, unidades y sublínea. La sublínea
// puede faltar si el pedido tiene una sola. Un EAN que ya está igual en el
// pedido se omite; distinto, es un error (se cambia con Editar). Las líneas se
// numeran como en el texto pegado.
function _analizarCarga(texto, pedido, estado) {
  let columnas = { ean: 0, unidades: 1, sublinea: 2 };
  let conEncabezado = false;
  let primera = true;
  const datos = [];
  String(texto || "")
    .split(/\r\n|\r|\n/)
    .forEach((linea, i) => {
      if (!linea.trim()) return;
      const celdas = _celdasLinea(linea);
      if (primera) {
        primera = false;
        const encabezado = _columnasCarga(celdas);
        if (encabezado) {
          columnas = encabezado;
          conEncabezado = true;
          return;
        }
      }
      datos.push({ linea: i + 1, celdas });
    });
  if (datos.length === 0)
    throw new Error("Pega al menos una fila con el EAN y sus unidades.");
  if (datos.length > MAX_FILAS_CARGA)
    throw new Error(
      "Máximo " +
        MAX_FILAS_CARGA +
        " filas por carga (pegaste " +
        datos.length +
        "). Divídela en partes.",
    );

  const vistos = [];
  const nuevos = [];
  const filas = datos.map(({ linea, celdas }) => {
    const celda = (campo) =>
      columnas[campo] === undefined
        ? ""
        : String(celdas[columnas[campo]] || "").trim();
    const fila = {
      linea,
      ean: celda("ean"),
      sublinea: celda("sublinea"),
      unidades: celda("unidades"),
      estado: "error",
      mensaje: "",
    };
    try {
      if (!conEncabezado && celdas.slice(3).some((c) => c !== ""))
        throw new Error(
          "Tiene más de 3 columnas. Sin encabezado, el orden es EAN, unidades y sublínea.",
        );
      const pedidoFila = celda("pedido");
      if (
        pedidoFila &&
        _normalizarPedido(pedidoFila) !== _normalizarPedido(pedido)
      )
        throw new Error("Es del pedido " + pedidoFila + ".");
      if (/^\d+([.,]\d+)?e[+-]?\d+$/i.test(fila.ean))
        throw new Error(
          "Excel pasó el EAN a notación científica y se perdieron dígitos: da formato de texto a la columna y vuelve a copiar.",
        );
      const ean = _eanValidado(fila.ean);
      fila.ean = ean;
      const esCero = ean === "0";

      const unidades = _unidadesPegadas(fila.unidades);
      if (unidades === "")
        throw new Error(
          'Faltan las unidades. Un EAN sin límite se agrega con "+ Agregar EAN".',
        );
      if (
        unidades === null ||
        unidades < (esCero ? 0 : 1) ||
        unidades > MAX_UNIDADES_PEDIDO
      )
        throw new Error(
          esCero
            ? "Unidades no válidas: el EAN 0 lleva un número entero desde 0."
            : "Unidades no válidas: debe ser un número entero mayor que 0, sin decimales.",
        );
      fila.unidades = unidades;

      let sublinea;
      if (!fila.sublinea) {
        if (estado.sublineas.length !== 1)
          throw new Error(
            "Falta la sublínea: el pedido tiene varias (" +
              estado.sublineas.join(", ") +
              ").",
          );
        sublinea = estado.sublineas[0];
      } else {
        sublinea = estado.sublineas.find(
          (s) => _normalizarPedido(s) === _normalizarPedido(fila.sublinea),
        );
        if (!sublinea)
          throw new Error(
            'La sublínea "' +
              fila.sublinea +
              '" no es del pedido (tiene: ' +
              estado.sublineas.join(", ") +
              ").",
          );
      }
      fila.sublinea = sublinea;

      const previa = vistos.find((v) => _mismoEan(v.ean, ean));
      if (previa)
        throw new Error(
          (esCero ? "Solo puede haber un EAN 0" : "Repetido") +
            ": ya está en la línea " +
            previa.linea +
            ".",
        );
      vistos.push({ ean, linea });

      const existente = estado.eanes.find((e) => _mismoEan(e.ean, ean));
      if (existente) {
        if (
          existente.sublinea === sublinea &&
          !existente.sinLimite &&
          existente.totales === unidades
        ) {
          fila.ean = existente.ean;
          fila.estado = "igual";
          fila.mensaje = "Ya está en el pedido así: se omite.";
          return fila;
        }
        throw new Error(
          (esCero ? "El pedido ya tiene un EAN 0" : "Ya está en el pedido") +
            (existente.sinLimite
              ? " sin límite"
              : " con " + existente.totales + " unidades") +
            ' en la sublínea "' +
            existente.sublinea +
            '": cámbialo con Editar.',
        );
      }
      fila.estado = "nuevo";
      nuevos.push({ ean, sublinea, unidades });
      return fila;
    } catch (err) {
      fila.mensaje = err.message;
      return fila;
    }
  });
  return { filas, nuevos };
}

export const accionesPlaneacion = {
  // Una entrada por número de pedido con sus sublíneas, cuántos EAN tiene cada
  // una y si el pedido ya tiene registros (en F2b decide qué se puede editar o
  // borrar). Incluye los pedidos que solo existen en Validación eanes.
  async obtenerPedidosPlaneacion(datos, env) {
    const { results: filas } = await env.DB.prepare(
      "SELECT p.numero_pedido AS pedido, p.sublinea, p.cliente, p.evento, " +
        "p.clasificacion_proceso AS clasificacion, p.fecha, p.unidades_pedidas AS unidadesPedidas, " +
        "p.tipo, EXISTS(SELECT 1 FROM registros r WHERE r.numero_pedido = p.numero_pedido) AS conRegistros " +
        "FROM pedidos p",
    ).all();
    const { results: eanes } = await env.DB.prepare(
      "SELECT v.numero_pedido AS pedido, v.sublinea, COUNT(*) AS eanes, " +
        "SUM(CASE WHEN " +
        _sqlEanReferente("v.") +
        " THEN v.unidades_totales ELSE 0 END) AS unidadesEan, " +
        "EXISTS(SELECT 1 FROM registros r WHERE r.numero_pedido = v.numero_pedido) AS conRegistros " +
        "FROM validacion_eanes v GROUP BY v.numero_pedido, v.sublinea",
    ).all();

    const porPedido = new Map();
    const _entrada = (pedido) => {
      if (!porPedido.has(pedido)) {
        porPedido.set(pedido, {
          pedido,
          sublineas: [],
          conRegistros: false,
          porEtapas: false,
          unidadesPedidas: 0,
          unidadesEan: 0,
        });
      }
      return porPedido.get(pedido);
    };

    filas.forEach((f) => {
      const e = _entrada(f.pedido);
      e.conRegistros = e.conRegistros || f.conRegistros === 1;
      e.porEtapas = e.porEtapas || f.tipo === "etapas";
      e.unidadesPedidas = Math.max(
        e.unidadesPedidas,
        Number(f.unidadesPedidas) || 0,
      );
      e.sublineas.push({
        sublinea: f.sublinea,
        cliente: String(f.cliente || ""),
        evento: String(f.evento || ""),
        clasificacion: String(f.clasificacion || ""),
        fecha: String(f.fecha || ""),
        eanes: 0,
        enPedidos: true,
      });
    });

    eanes.forEach((v) => {
      const e = _entrada(v.pedido);
      e.conRegistros = e.conRegistros || v.conRegistros === 1;
      e.unidadesEan += Number(v.unidadesEan) || 0;
      const s = e.sublineas.find((x) => x.sublinea === v.sublinea);
      if (s) s.eanes = v.eanes;
      else
        e.sublineas.push({
          sublinea: v.sublinea,
          cliente: "",
          evento: "",
          clasificacion: "",
          fecha: "",
          eanes: v.eanes,
          enPedidos: false,
        });
    });

    const pedidos = [...porPedido.values()].map((e) => {
      e.sublineas.sort((a, b) =>
        String(a.sublinea).localeCompare(String(b.sublinea), "es", {
          numeric: true,
        }),
      );
      const reales = e.sublineas.filter((s) => s.enPedidos);
      const huerfanas = e.sublineas.filter((s) => !s.enPedidos);
      const nEanes = e.sublineas.reduce((s, x) => s + x.eanes, 0);
      const alertas = [];
      // Campos que deberían ser del pedido y difieren entre sus sublíneas
      // (pasa cuando dos clientes comparten número, como el 936).
      const difieren = {};
      ["cliente", "evento", "clasificacion", "fecha"].forEach((campo) => {
        difieren[campo] = _distintos(reales.map((s) => s[campo])).length > 1;
      });

      if (reales.length === 0) {
        alertas.push(
          "Existe solo en Validación eanes: falta en Numero pedidos.",
        );
      } else {
        huerfanas.forEach((s) =>
          alertas.push(
            'Tiene EAN con la sublínea "' +
              s.sublinea +
              '", que no está en Numero pedidos.',
          ),
        );
        if (reales.some((s) => !s.cliente)) alertas.push("Sin cliente.");
        if (reales.some((s) => !s.fecha)) alertas.push("Sin fecha.");
        if (difieren.fecha)
          alertas.push("Sus sublíneas tienen fechas distintas.");
        if (difieren.cliente)
          alertas.push("Sus sublíneas tienen clientes distintos.");
        if (difieren.evento)
          alertas.push("Sus sublíneas tienen eventos distintos.");
        if (difieren.clasificacion)
          alertas.push("Sus sublíneas tienen clasificaciones distintas.");
        _distintos(reales.map((s) => s.evento))
          .filter((v) => !_enLista(v, EVENTOS_PEDIDO))
          .forEach((v) =>
            alertas.push('Evento fuera de la lista: "' + v + '".'),
          );
        _distintos(reales.map((s) => s.clasificacion))
          .filter((v) => !_enLista(v, CLASIFICACIONES_PEDIDO))
          .forEach((v) =>
            alertas.push('Clasificación fuera de la lista: "' + v + '".'),
          );
        // Por etapas cada etapa lleva las unidades pedidas: la suma no aplica.
        const sumaEan =
          nEanes && !e.porEtapas
            ? _alertaSumaEan(e.unidadesEan, e.unidadesPedidas)
            : "";
        if (sumaEan) alertas.push(sumaEan);
      }

      // Datos del pedido: los de su primera sublínea. Los campos que difieren
      // van marcados en "difieren" y la tarjeta los muestra por sublínea.
      const base = reales[0] || {};
      const fechas = reales
        .map((s) => s.fecha)
        .filter(Boolean)
        .sort();
      return {
        pedido: e.pedido,
        // Igual que Seguimiento de paquetes: la fecha más antigua.
        fecha: fechas[0] || "",
        cliente: base.cliente || "",
        evento: base.evento || "",
        clasificacion: base.clasificacion || "",
        difieren,
        sublineas: e.sublineas,
        eanes: nEanes,
        unidadesPedidas: e.unidadesPedidas,
        unidadesEan: _redondear2(e.unidadesEan),
        conRegistros: e.conRegistros,
        porEtapas: e.porEtapas,
        soloEnValidacion: reales.length === 0,
        alertas,
      };
    });

    // Lo más reciente primero; sin fecha al fondo; empate por número.
    pedidos.sort(
      (a, b) =>
        String(b.fecha).localeCompare(String(a.fecha)) ||
        String(a.pedido).localeCompare(String(b.pedido), "es", {
          numeric: true,
        }),
    );

    return {
      success: true,
      pedidos,
      eventos: EVENTOS_PEDIDO,
      clasificaciones: CLASIFICACIONES_PEDIDO,
      edicionHabilitada: await _edicionHabilitada(env, ["pedidos", "procesos"]),
    };
  },

  // Clientes agrupados por nombre normalizado, con sus variantes de escritura.
  // Une la tabla clientes (vacía hasta el corte F4) con pedidos.cliente, así
  // que la misma acción sirve antes y después del corte. pedidosAbiertos:
  // los que no han cerrado (deciden si el cliente se puede eliminar).
  async obtenerClientesPlaneacion(datos, env) {
    const { results: usados } = await env.DB.prepare(
      "SELECT cliente, COUNT(*) AS pedidos, SUM(abierto) AS abiertos FROM (" +
        _sqlPedidosPorCliente() +
        ") GROUP BY cliente",
    ).all();
    const { results: tabla } = await env.DB.prepare(
      "SELECT nombre, activo FROM clientes",
    ).all();

    const grupos = new Map();
    const _grupo = (nombre) => {
      const clave = _normalizarPedido(nombre);
      if (!grupos.has(clave)) {
        grupos.set(clave, {
          variantes: [],
          enTabla: false,
          nombreTabla: "",
          activo: null,
        });
      }
      return grupos.get(clave);
    };

    let pedidosSinCliente = 0;
    usados.forEach((u) => {
      const nombre = String(u.cliente || "").trim();
      if (!nombre) {
        pedidosSinCliente += u.pedidos;
        return;
      }
      _grupo(nombre).variantes.push({
        nombre,
        pedidos: u.pedidos,
        abiertos: Number(u.abiertos) || 0,
      });
    });
    tabla.forEach((t) => {
      const g = _grupo(t.nombre);
      g.enTabla = true;
      g.nombreTabla = t.nombre;
      g.activo = t.activo === 1;
    });

    const clientes = [...grupos.values()].map((g) => {
      g.variantes.sort((a, b) => b.pedidos - a.pedidos);
      return {
        // Con tabla manda su nombre; sin ella, la variante más usada.
        nombre: g.nombreTabla || (g.variantes[0] && g.variantes[0].nombre),
        variantes: g.variantes,
        pedidos: g.variantes.reduce((s, v) => s + v.pedidos, 0),
        pedidosAbiertos: g.variantes.reduce((s, v) => s + v.abiertos, 0),
        enTabla: g.enTabla,
        activo: g.activo,
      };
    });
    clientes.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

    return {
      success: true,
      clientes,
      tablaCargada: tabla.length > 0,
      pedidosSinCliente,
      edicionHabilitada: await _edicionHabilitada(env, ["pedidos"]),
    };
  },

  // Datos para el formulario de crear pedido. Antes del corte la tabla
  // clientes está vacía: se muestran los nombres de Numero pedidos (solo para
  // ver el formulario; crear sigue bloqueado por el interruptor).
  async obtenerFormularioPedido(datos, env) {
    const { results: tabla } = await env.DB.prepare(
      "SELECT nombre FROM clientes WHERE activo = 1",
    ).all();
    let clientes = tabla.map((t) => t.nombre);
    const clientesDesdePedidos = tabla.length === 0;
    if (clientesDesdePedidos) {
      const r = await accionesPlaneacion.obtenerClientesPlaneacion({}, env);
      clientes = r.clientes.map((c) => c.nombre);
    }
    clientes.sort((a, b) => a.localeCompare(b, "es"));

    // Procesos: los activos del catálogo. Los generales vienen marcados.
    const procesos = [...(await _catalogoProcesos(env)).values()]
      .filter((c) => c.activo)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
      .map((c) => ({
        nombre: c.nombre,
        estandar: c.estandar,
        link: c.link,
        general: c.general,
      }));
    const generales = procesos.filter((c) => c.general);
    const sublineas = [...(await _sublineasUsadas(env)).values()]
      .sort((a, b) => b.usos - a.usos)
      .map((s) => s.nombre);

    return {
      success: true,
      clientes,
      clientesDesdePedidos,
      sublineas,
      procesos,
      generales,
      eventos: EVENTOS_PEDIDO,
      clasificaciones: CLASIFICACIONES_PEDIDO,
      fecha: _fechaHoyBogota(),
      edicionHabilitada: await _edicionHabilitada(env, ["pedidos", "procesos"]),
    };
  },

  // Crea un pedido (o una actividad interna) con sus sublíneas y procesos en
  // un solo batch. El número de un pedido lo genera el sistema y no se
  // recalcula nunca; si alguien se equivoca, se borra y se crea de nuevo.
  // Los procesos salen del catálogo activo (F5 · P2), con su estándar y su
  // link; si alguno cambia en el catálogo antes de guardar, no se crea nada.
  // Por etapas (24-11): una sola sublínea y, en cada proceso, cuenta: true
  // para los que son etapa (ver "Pedidos por etapas").
  // datos: { idEnvio, tipo: "pedido"|"interna"|"etapas", unidades, nombre,
  //   cliente, sublineas[], evento, clasificacion, procesos[{nombre, cuenta}],
  //   sinLimite }
  async crearPedido(datos, env, ctx, ip, sesion) {
    if (!String(datos.idEnvio || "").trim())
      throw new Error("Falta el identificador del envío. Recarga la página.");
    const huella = await _huellaPayload("crearPedido", datos);
    const chequeo = await _chequearIdempotencia(env, huella);
    if (chequeo.duplicado) return chequeo.respuesta;
    if (chequeo.enProceso) {
      return {
        success: false,
        message:
          "Este pedido ya se está creando (posible doble envío). Espera unos segundos y revisa la lista antes de reintentar.",
      };
    }

    try {
      await _exigirCatalogoEnApp(env, "pedidos");
      await _exigirCatalogoEnApp(env, "procesos");

      const interna = datos.tipo === "interna";
      const etapas = datos.tipo === "etapas";
      if (!interna && !etapas && datos.tipo !== "pedido")
        throw new Error("Tipo de pedido no válido.");

      // --- Unidades o nombre ---
      let unidades = 0;
      let nombreInterna = "";
      if (interna) {
        nombreInterna = _limpiar(datos.nombre);
        if (nombreInterna.length < 2 || nombreInterna.length > 60)
          throw new Error(
            "El nombre de la actividad debe tener entre 2 y 60 caracteres.",
          );
        if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(nombreInterna))
          throw new Error(
            "El nombre de la actividad solo puede tener letras, números, espacios, punto, guion y guion bajo.",
          );
      } else {
        unidades = Number(datos.unidades);
        if (
          !Number.isInteger(unidades) ||
          unidades < 1 ||
          unidades > MAX_UNIDADES_PEDIDO
        )
          throw new Error(
            "Las unidades pedidas deben ser un número entero mayor que 0.",
          );
      }

      // --- Cliente: de la tabla, activo ---
      const claveCliente = _normalizarPedido(datos.cliente);
      if (!claveCliente) throw new Error("Selecciona el cliente.");
      const { results: clientes } = await env.DB.prepare(
        "SELECT nombre FROM clientes WHERE activo = 1",
      ).all();
      const cliente = clientes.find(
        (c) => _normalizarPedido(c.nombre) === claveCliente,
      );
      if (!cliente)
        throw new Error(
          'El cliente "' +
            _limpiar(datos.cliente) +
            '" no está en la lista de clientes activos.',
        );

      // --- Evento y clasificación: listas fijas ---
      const evento = EVENTOS_PEDIDO.find(
        (v) => _normalizarPedido(v) === _normalizarPedido(datos.evento),
      );
      if (!evento) throw new Error("Selecciona un evento de la lista.");
      const clasificacion = CLASIFICACIONES_PEDIDO.find(
        (v) => _normalizarPedido(v) === _normalizarPedido(datos.clasificacion),
      );
      if (!clasificacion)
        throw new Error("Selecciona una clasificación de la lista.");

      // --- Sublíneas: texto libre, con la escritura ya usada si existe ---
      const usadas = await _sublineasUsadas(env);
      const sublineas = [];
      const vistasSub = new Set();
      (Array.isArray(datos.sublineas) ? datos.sublineas : []).forEach((s) => {
        const texto = _limpiar(s);
        const clave = _normalizarPedido(texto);
        if (!clave || vistasSub.has(clave)) return;
        if (texto.length > 60)
          throw new Error('La sublínea "' + texto + '" pasa de 60 caracteres.');
        vistasSub.add(clave);
        sublineas.push(usadas.has(clave) ? usadas.get(clave).nombre : texto);
      });
      if (sublineas.length === 0)
        throw new Error("Agrega al menos una sublínea.");
      if (sublineas.length > MAX_SUBLINEAS)
        throw new Error("Máximo " + MAX_SUBLINEAS + " sublíneas por pedido.");
      if (etapas && sublineas.length !== 1)
        throw new Error("Un pedido por etapas lleva una sola sublínea.");

      // --- Procesos: del catálogo activo, con su estándar y su link ---
      const catalogo = await _catalogoProcesos(env);
      const procesos = [];
      const vistosProc = new Set();
      (Array.isArray(datos.procesos) ? datos.procesos : []).forEach((p) => {
        const clave = _normalizarPedido(_limpiar(p && p.nombre));
        if (clave && vistosProc.has(clave))
          throw new Error(
            'El proceso "' + _limpiar(p.nombre) + '" está repetido.',
          );
        const c = _procesoDelCatalogo(p, catalogo);
        vistosProc.add(c.clave);
        procesos.push({ ...c, cuenta: etapas && p.cuenta === true });
      });
      if (procesos.length === 0) throw new Error("Agrega al menos un proceso.");
      if (procesos.length > MAX_PROCESOS)
        throw new Error("Máximo " + MAX_PROCESOS + " procesos por pedido.");
      // Etapas: los procesos que cuentan, en el orden de la lista. El código
      // de cada etapa no cambia nunca: queda guardado en sus registros.
      const listaEtapas = procesos.filter((p) => p.cuenta);
      listaEtapas.forEach((p, i) => {
        p.orden = i + 1;
        p.etapaEan = PREFIJO_ETAPA + (i + 1);
      });
      if (etapas && listaEtapas.length === 0)
        throw new Error(
          "Marca al menos un proceso como etapa (que cuenta unidades).",
        );

      const sinLimite = interna && datos.sinLimite === true;
      const fecha = _fechaHoyBogota();
      const ahora = _ahoraISO();
      const guardaCatalogo = _guardaCatalogo(procesos);

      // --- Número y batch, con reintento si otro lo tomó entre medias ---
      let respuesta = null;
      for (let intento = 1; intento <= 3 && !respuesta; intento++) {
        const existentes = await _numerosExistentes(env);
        let pedido;
        if (interna) {
          if (existentes.has(_normalizarPedido(nombreInterna)))
            throw new Error(
              'Ya existe un pedido o actividad llamado "' +
                nombreInterna +
                '".',
            );
          pedido = nombreInterna;
        } else {
          pedido = _numeroAutomatico(unidades, procesos, existentes);
        }

        const despues = {
          pedido,
          tipo: interna ? "interna" : etapas ? "etapas" : "pedido",
          unidadesPedidas: unidades,
          cliente: cliente.nombre,
          sublineas,
          evento,
          clasificacion,
          fecha,
          procesos: procesos.map((p) => ({
            nombre: p.nombre,
            estandar: p.estandar,
            link: p.link,
            ...(etapas ? { etapa: p.etapaEan || "" } : {}),
          })),
          sinLimite,
        };
        const lote = [
          _auditoriaConGuarda(
            env,
            {
              tabla: "pedidos",
              llave: pedido,
              accion: "crear",
              despues,
              cedula: sesion.cedula,
              nombre: sesion.nombre || "",
              hechoEn: ahora,
            },
            "EXISTS(SELECT 1 FROM pedidos WHERE numero_pedido = ?) OR " +
              "EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ?) OR " +
              guardaCatalogo.condicion,
            [pedido, pedido, ...guardaCatalogo.binds],
          ),
        ];
        sublineas.forEach((s) =>
          lote.push(
            env.DB.prepare(
              "INSERT INTO pedidos (numero_pedido, cliente, sublinea, evento, clasificacion_proceso, fecha, unidades_pedidas, tipo) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ).bind(
              pedido,
              cliente.nombre,
              s,
              evento,
              clasificacion,
              fecha,
              unidades,
              etapas ? "etapas" : "",
            ),
          ),
        );
        procesos.forEach((p) =>
          lote.push(
            env.DB.prepare(
              "INSERT INTO procesos (nombre_proceso, unidades_hora_estandar, numero_pedido, link_procesos, etapa_ean, orden_etapa) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
            ).bind(
              p.nombre,
              p.estandar,
              pedido,
              p.link,
              p.etapaEan || "",
              p.orden || 0,
            ),
          ),
        );
        // Etapas: una fila por etapa con la meta en las unidades pedidas.
        listaEtapas.forEach((p) =>
          lote.push(
            env.DB.prepare(
              "INSERT INTO validacion_eanes (numero_pedido, ean_producto, sublinea, unidades_totales, sin_limite, actualizado_en) " +
                "VALUES (?, ?, ?, ?, 0, ?)",
            ).bind(pedido, p.etapaEan, sublineas[0], unidades, ahora),
          ),
        );
        // Sin límite: EAN 0 (trabajo sin unidades estimadas) en la primera
        // sublínea. No es referente: no cuenta para el cierre del pedido. Un
        // pedido por etapas también lo lleva, para los procesos que no cuentan.
        if (sinLimite || etapas) {
          lote.push(
            env.DB.prepare(
              "INSERT INTO validacion_eanes (numero_pedido, ean_producto, sublinea, unidades_totales, sin_limite, actualizado_en) " +
                "VALUES (?, '0', ?, 0, 1, ?)",
            ).bind(pedido, sublineas[0], ahora),
          );
        }

        try {
          await env.DB.batch(lote);
          respuesta = {
            success: true,
            pedido,
            fecha,
            sublineas,
            procesos: procesos.length,
            etapas: listaEtapas.length,
            sinLimite,
          };
        } catch (errLote) {
          // Si el número ya existe, alguien lo tomó entre la lectura y el
          // batch: un pedido vuelve a generar número, una actividad no.
          const tomado = await env.DB.prepare(
            "SELECT 1 FROM pedidos WHERE numero_pedido = ?1 UNION ALL " +
              "SELECT 1 FROM validacion_eanes WHERE numero_pedido = ?1 LIMIT 1",
          )
            .bind(pedido)
            .first();
          if (!tomado) {
            const cambio = await env.DB.prepare(
              "SELECT CASE WHEN " +
                guardaCatalogo.condicion +
                " THEN 1 ELSE 0 END AS si",
            )
              .bind(...guardaCatalogo.binds)
              .first();
            if (cambio && cambio.si === 1) throw new Error(MSG_CATALOGO_CAMBIO);
            throw errLote;
          }
          if (interna || intento === 3)
            throw new Error(
              'El número "' +
                pedido +
                '" se acaba de ocupar. Intenta de nuevo.',
            );
        }
      }

      await _confirmarIdempotencia(env, huella, respuesta);
      return respuesta;
    } catch (err) {
      await _liberarIdempotencia(env, huella);
      throw err;
    }
  },

  // Elimina un pedido sin registros ni justificaciones: sus filas de pedidos,
  // procesos, Validación eanes y control_produccion. Con soloResumen devuelve
  // lo que se borraría, sin tocar nada (para el modal de confirmación).
  async eliminarPedido(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");

    const { results: filasPedido } = await env.DB.prepare(
      "SELECT numero_pedido, cliente, sublinea, evento, clasificacion_proceso, fecha, unidades_pedidas " +
        "FROM pedidos WHERE numero_pedido = ?",
    )
      .bind(pedido)
      .all();
    const { results: filasProcesos } = await env.DB.prepare(
      "SELECT nombre_proceso, unidades_hora_estandar, link_procesos FROM procesos WHERE numero_pedido = ?",
    )
      .bind(pedido)
      .all();
    const { results: filasEanes } = await env.DB.prepare(
      "SELECT ean_producto, sublinea, unidades_totales, sin_limite FROM validacion_eanes WHERE numero_pedido = ?",
    )
      .bind(pedido)
      .all();
    const uso = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM registros WHERE numero_pedido = ?1) AS registros, " +
        "(SELECT COUNT(*) FROM justificaciones WHERE pedido = ?1) AS justificaciones",
    )
      .bind(pedido)
      .first();

    if (filasPedido.length === 0 && filasEanes.length === 0)
      throw new Error("El pedido " + pedido + " no existe.");

    let bloqueo = "";
    if (uso.registros > 0)
      bloqueo =
        "Tiene " +
        uso.registros +
        (uso.registros === 1 ? " registro" : " registros") +
        " de producción: no se puede eliminar.";
    else if (uso.justificaciones > 0)
      bloqueo = "Tiene justificaciones: no se puede eliminar.";

    const resumen = {
      pedido,
      sublineas: filasPedido.map((f) => f.sublinea),
      procesos: filasProcesos.length,
      eanes: filasEanes.length,
      bloqueo,
    };
    if (datos.soloResumen === true) return { success: true, resumen };

    await _exigirCatalogoEnApp(env, "pedidos");
    await _exigirCatalogoEnApp(env, "procesos");
    if (bloqueo) throw new Error(bloqueo);

    // La guarda vuelve a mirar registros y justificaciones dentro del batch:
    // si llegó un registro después de la lectura, no se borra nada.
    await env.DB.batch([
      _auditoriaConGuarda(
        env,
        {
          tabla: "pedidos",
          llave: pedido,
          accion: "eliminar",
          antes: {
            pedidos: filasPedido,
            procesos: filasProcesos,
            eanes: filasEanes,
          },
          cedula: sesion.cedula,
          nombre: sesion.nombre || "",
          hechoEn: _ahoraISO(),
        },
        "EXISTS(SELECT 1 FROM registros WHERE numero_pedido = ?) OR " +
          "EXISTS(SELECT 1 FROM justificaciones WHERE pedido = ?)",
        [pedido, pedido],
      ),
      env.DB.prepare("DELETE FROM pedidos WHERE numero_pedido = ?").bind(
        pedido,
      ),
      env.DB.prepare("DELETE FROM procesos WHERE numero_pedido = ?").bind(
        pedido,
      ),
      env.DB.prepare(
        "DELETE FROM validacion_eanes WHERE numero_pedido = ?",
      ).bind(pedido),
      env.DB.prepare(
        "DELETE FROM control_produccion WHERE numero_pedido = ?",
      ).bind(pedido),
    ]);

    return { success: true, resumen };
  },

  // Clientes: crear, desactivar, reactivar o eliminar. Desactivar saca al
  // cliente del formulario de pedidos (no se le crean más), y los pedidos que
  // ya tiene se siguen trabajando. Eliminar (20-11) exige que esté inactivo y
  // sin pedidos abiertos: sus pedidos cerrados y sus registros guardan el
  // nombre como texto y no dependen de esta tabla.
  // datos: { accion: "crear"|"desactivar"|"reactivar"|"eliminar", nombre }
  async guardarCliente(datos, env, ctx, ip, sesion) {
    await _exigirCatalogoEnApp(env, "pedidos");
    const accion = String(datos.accion || "");
    const nombre = _limpiar(datos.nombre);
    const clave = _normalizarPedido(nombre);
    if (!clave) throw new Error("Escribe el nombre del cliente.");

    const { results: tabla } = await env.DB.prepare(
      "SELECT nombre, activo FROM clientes",
    ).all();
    const existente = tabla.find((t) => _normalizarPedido(t.nombre) === clave);
    const fila = {
      tabla: "clientes",
      cedula: sesion.cedula,
      nombre: sesion.nombre || "",
      hechoEn: _ahoraISO(),
    };

    if (accion === "crear") {
      if (nombre.length > 80)
        throw new Error("El nombre del cliente pasa de 80 caracteres.");
      if (existente)
        throw new Error(
          'Ya existe el cliente "' +
            existente.nombre +
            '"' +
            (existente.activo === 1 ? "." : " (inactivo): reactívalo."),
        );
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO clientes (nombre, activo, creado_en) VALUES (?, 1, ?)",
        ).bind(nombre, fila.hechoEn),
        _auditoria(env, {
          ...fila,
          llave: nombre,
          accion: "crear",
          despues: { nombre, activo: 1 },
        }),
      ]);
      return { success: true, nombre, activo: true };
    }

    if (accion === "desactivar" || accion === "reactivar") {
      if (!existente)
        throw new Error('El cliente "' + nombre + '" no está en la tabla.');
      const activo = accion === "reactivar" ? 1 : 0;
      if (existente.activo === activo)
        return { success: true, nombre: existente.nombre, activo: !!activo };
      await env.DB.batch([
        env.DB.prepare("UPDATE clientes SET activo = ? WHERE nombre = ?").bind(
          activo,
          existente.nombre,
        ),
        _auditoria(env, {
          ...fila,
          llave: existente.nombre,
          accion: activo ? "activar" : "desactivar",
          antes: { activo: existente.activo },
          despues: { activo },
        }),
      ]);
      return { success: true, nombre: existente.nombre, activo: !!activo };
    }

    if (accion === "eliminar") {
      // Ya no está: un reintento tras un error de red.
      if (!existente)
        return { success: true, nombre, eliminado: true, sinCambios: true };
      if (existente.activo === 1)
        throw new Error(
          'Desactiva primero el cliente "' + existente.nombre + '".',
        );
      const { results: pedidos } = await env.DB.prepare(
        _sqlPedidosPorCliente(),
      ).all();
      const suyos = pedidos.filter(
        (p) => _normalizarPedido(p.cliente) === clave,
      );
      const abiertos = _distintos(
        suyos.filter((p) => p.abierto === 1).map((p) => String(p.pedido)),
      );
      if (abiertos.length)
        throw new Error(
          'El cliente "' +
            existente.nombre +
            '" tiene ' +
            (abiertos.length === 1
              ? "1 pedido sin cerrar"
              : abiertos.length + " pedidos sin cerrar") +
            " (" +
            abiertos.slice(0, 5).join(", ") +
            (abiertos.length > 5 ? "…" : "") +
            "): se podrá eliminar cuando estén cerrados.",
        );

      // Guarda: sigue inactivo y ninguno de sus pedidos se reabrió entre la
      // lectura y el batch (por ejemplo, al agregarle un EAN). Un pedido nuevo
      // no puede llegar: crear y editar pedido solo aceptan clientes activos.
      const condicion =
        "NOT EXISTS(SELECT 1 FROM clientes WHERE nombre = ? AND activo = 0) OR " +
        "EXISTS(SELECT 1 FROM json_each(?) j WHERE " +
        _sqlPedidoAbierto("j.value") +
        ")";
      const binds = [
        existente.nombre,
        JSON.stringify(_distintos(suyos.map((p) => String(p.pedido)))),
      ];
      try {
        await env.DB.batch([
          _auditoriaConGuarda(
            env,
            {
              ...fila,
              llave: existente.nombre,
              accion: "eliminar",
              antes: {
                nombre: existente.nombre,
                activo: existente.activo,
                pedidosCerrados: suyos.length,
              },
            },
            condicion,
            binds,
          ),
          env.DB.prepare(
            "DELETE FROM clientes WHERE nombre = ? AND activo = 0",
          ).bind(existente.nombre),
        ]);
      } catch (errLote) {
        const guarda = await env.DB.prepare(
          "SELECT CASE WHEN " + condicion + " THEN 1 ELSE 0 END AS bloqueado",
        )
          .bind(...binds)
          .first();
        if (guarda && guarda.bloqueado === 1)
          throw new Error(
            'El cliente "' +
              existente.nombre +
              '" cambió mientras lo eliminabas (se reactivó o se reabrió uno de sus pedidos). Recarga la lista.',
          );
        throw errLote;
      }
      return { success: true, nombre: existente.nombre, eliminado: true };
    }

    throw new Error("Acción de cliente no válida.");
  },

  // F2b-2: datos para editar un pedido (su estado actual con lo que bloquea
  // cada sublínea y proceso) más los catálogos del formulario de crear. Cada
  // proceso del pedido dice además cómo está en el catálogo (F5 · P2): si
  // está, si está activo y su estándar y su link de allá.
  async obtenerPedidoParaEditar(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    const estado = await _estadoPedido(env, pedido);
    if (!estado.existe) throw _errorPedidoNoEditable(pedido, estado);
    if (await _esPedidoPorEtapas(env, pedido))
      throw new Error(MSG_PEDIDO_ETAPAS_EDITAR);
    const formulario = await accionesPlaneacion.obtenerFormularioPedido(
      {},
      env,
    );
    delete formulario.success;
    const catalogo = await _catalogoProcesos(env);
    return {
      success: true,
      formulario,
      pedido: {
        pedido,
        cliente: estado.cliente,
        evento: estado.evento,
        clasificacion: estado.clasificacion,
        difieren: estado.difieren,
        fecha: estado.fecha,
        unidadesPedidas: estado.unidadesPedidas,
        unidadesEditables: estado.unidadesEditables,
        sublineas: estado.sublineas,
        procesos: estado.procesos.map((p) => {
          const c = catalogo.get(_normalizarPedido(p.nombre));
          return {
            ...p,
            enCatalogo: !!c,
            activo: !!(c && c.activo),
            estandarCatalogo: c ? c.estandar : null,
            linkCatalogo: c ? c.link : null,
          };
        }),
        huella: estado.huella,
      },
    };
  },

  // Edita un pedido. Recibe cómo debe quedar y el Worker calcula qué cambió:
  // - cliente, evento y clasificación van a todas las sublíneas y a sus
  //   registros (la hoja Registros se pone al día con la reconciliación);
  // - sublíneas: se agregan siempre; se quitan solo sin EAN;
  // - procesos: se agregan solo del catálogo activo (F5 · P2) y se quitan
  //   solo sin registros; los que ya tiene el pedido no se tocan;
  // - unidades pedidas: solo si el pedido viene de la hoja y las tiene en 0.
  // Sin cambios responde éxito (sirve también para un reintento tras un error
  // de red). Si el pedido cambió desde que se abrió (huella distinta), no
  // guarda. Si el pedido está cerrado y cambió el cliente, refresca su fila de
  // "Seguimiento paquetes".
  // datos: { pedido, huella, cliente, evento, clasificacion, unidades,
  //   sublineas[], procesos[{nombre}] }
  async editarPedido(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    await _exigirCatalogoEnApp(env, "pedidos");
    await _exigirCatalogoEnApp(env, "procesos");

    const actual = await _estadoPedido(env, pedido);
    if (!actual.existe) throw _errorPedidoNoEditable(pedido, actual);
    if (await _esPedidoPorEtapas(env, pedido))
      throw new Error(MSG_PEDIDO_ETAPAS_EDITAR);

    // --- Cliente: si no cambia se conserva (aunque esté inactivo o escrito
    // distinto); si cambia, debe ser un cliente activo de la tabla ---
    const claveCliente = _normalizarPedido(datos.cliente);
    if (!claveCliente) throw new Error("Selecciona el cliente.");
    let cliente = actual.cliente;
    if (
      actual.difieren.cliente ||
      !actual.cliente ||
      claveCliente !== _normalizarPedido(actual.cliente)
    ) {
      const { results: activos } = await env.DB.prepare(
        "SELECT nombre FROM clientes WHERE activo = 1",
      ).all();
      const elegido = activos.find(
        (c) => _normalizarPedido(c.nombre) === claveCliente,
      );
      if (!elegido)
        throw new Error(
          'El cliente "' +
            _limpiar(datos.cliente) +
            '" no está en la lista de clientes activos.',
        );
      cliente = elegido.nombre;
    }

    // --- Evento y clasificación: siempre de las listas fijas ---
    const evento = _valorDeLista(
      datos.evento,
      EVENTOS_PEDIDO,
      actual.evento,
      actual.difieren.evento,
      "Selecciona un evento de la lista.",
    );
    const clasificacion = _valorDeLista(
      datos.clasificacion,
      CLASIFICACIONES_PEDIDO,
      actual.clasificacion,
      actual.difieren.clasificacion,
      "Selecciona una clasificación de la lista.",
    );

    // --- Unidades pedidas ---
    let unidades = actual.unidadesPedidas;
    const pideUnidades =
      datos.unidades !== undefined &&
      datos.unidades !== null &&
      datos.unidades !== "";
    if (pideUnidades && Number(datos.unidades) !== actual.unidadesPedidas) {
      if (!actual.unidadesEditables)
        throw new Error(
          "Las unidades pedidas de este pedido no se pueden cambiar.",
        );
      unidades = Number(datos.unidades);
      if (
        !Number.isInteger(unidades) ||
        unidades < 1 ||
        unidades > MAX_UNIDADES_PEDIDO
      )
        throw new Error(
          "Las unidades pedidas deben ser un número entero mayor que 0.",
        );
    }

    // --- Sublíneas ---
    const usadas = await _sublineasUsadas(env);
    const subActuales = new Map(
      actual.sublineas.map((s) => [_normalizarPedido(s.sublinea), s]),
    );
    const sublineas = [];
    const vistasSub = new Set();
    (Array.isArray(datos.sublineas) ? datos.sublineas : []).forEach((s) => {
      const texto = _limpiar(s);
      const clave = _normalizarPedido(texto);
      if (!clave || vistasSub.has(clave)) return;
      vistasSub.add(clave);
      const existente = subActuales.get(clave);
      if (existente) {
        sublineas.push(existente.sublinea);
        return;
      }
      if (texto.length > 60)
        throw new Error('La sublínea "' + texto + '" pasa de 60 caracteres.');
      sublineas.push(usadas.has(clave) ? usadas.get(clave).nombre : texto);
    });
    if (sublineas.length === 0)
      throw new Error("El pedido debe tener al menos una sublínea.");
    if (sublineas.length > MAX_SUBLINEAS)
      throw new Error("Máximo " + MAX_SUBLINEAS + " sublíneas por pedido.");
    const subNuevas = sublineas.filter(
      (s) => !subActuales.has(_normalizarPedido(s)),
    );
    const subQuitadas = actual.sublineas.filter(
      (s) => !vistasSub.has(_normalizarPedido(s.sublinea)),
    );
    const subConEan = subQuitadas.find((s) => s.eanes > 0);
    if (subConEan)
      throw new Error(
        'La sublínea "' +
          subConEan.sublinea +
          '" tiene EAN: no se puede quitar.',
      );

    // --- Procesos ---
    // Uno que ya está en el pedido se deja tal cual, aunque haya quedado
    // inactivo o fuera del catálogo (la alineación del corte lo iguala). Uno
    // nuevo sale del catálogo activo, con su estándar y su link.
    const catalogo = await _catalogoProcesos(env);
    const procActuales = new Map(
      actual.procesos.map((p) => [_normalizarPedido(p.nombre), p]),
    );
    const procesos = []; // { nombre, estandar, link, estado }
    const vistosProc = new Set();
    (Array.isArray(datos.procesos) ? datos.procesos : []).forEach((p) => {
      const clave = _normalizarPedido(_limpiar(p && p.nombre));
      if (clave && vistosProc.has(clave))
        throw new Error(
          'El proceso "' + _limpiar(p.nombre) + '" está repetido.',
        );
      const existente = clave && procActuales.get(clave);
      if (existente) {
        vistosProc.add(clave);
        procesos.push({ ...existente, estado: "igual" });
        return;
      }
      const c = _procesoDelCatalogo(p, catalogo);
      vistosProc.add(c.clave);
      procesos.push({ ...c, estado: "nuevo" });
    });
    if (procesos.length === 0)
      throw new Error("El pedido debe tener al menos un proceso.");
    if (procesos.length > MAX_PROCESOS)
      throw new Error("Máximo " + MAX_PROCESOS + " procesos por pedido.");
    const procNuevos = procesos.filter((p) => p.estado === "nuevo");
    const procQuitados = actual.procesos.filter(
      (p) => !vistosProc.has(_normalizarPedido(p.nombre)),
    );
    const procConRegistros = procQuitados.find((p) => p.registros > 0);
    if (procConRegistros)
      throw new Error(
        'El proceso "' +
          procConRegistros.nombre +
          '" tiene registros: no se puede quitar.',
      );

    // --- Qué cambió ---
    const datosCambian = actual.filas.some(
      (f) =>
        f.cliente !== cliente ||
        f.evento !== evento ||
        f.clasificacion !== clasificacion ||
        f.unidades !== unidades,
    );
    // Cliente, evento y clasificación también viajan en cada registro.
    const registrosCambian = actual.filas.some(
      (f) =>
        f.cliente !== cliente ||
        f.evento !== evento ||
        f.clasificacion !== clasificacion,
    );
    const clienteCambia = actual.filas.some((f) => f.cliente !== cliente);
    const hayCambios =
      datosCambian ||
      subNuevas.length > 0 ||
      subQuitadas.length > 0 ||
      procNuevos.length > 0 ||
      procQuitados.length > 0;
    if (!hayCambios) return { success: true, pedido, sinCambios: true };

    if (String(datos.huella || "") !== actual.huella)
      throw new Error(
        "El pedido cambió mientras lo editabas. Vuelve a abrirlo para ver los datos actuales.",
      );

    // --- Auditoría: solo lo que cambió ---
    const antes = {};
    const despues = {};
    if (datosCambian) {
      antes.filas = actual.filas.map((f) => ({
        sublinea: f.sublinea,
        cliente: f.cliente,
        evento: f.evento,
        clasificacion: f.clasificacion,
        unidadesPedidas: f.unidades,
      }));
      despues.datos = {
        cliente,
        evento,
        clasificacion,
        unidadesPedidas: unidades,
      };
    }
    if (subNuevas.length) despues.sublineasAgregadas = subNuevas;
    if (subQuitadas.length)
      antes.sublineasQuitadas = subQuitadas.map((s) => s.sublinea);
    const _proc = (p) => ({
      nombre: p.nombre,
      estandar: p.estandar,
      link: p.link,
    });
    if (procNuevos.length) despues.procesosAgregados = procNuevos.map(_proc);
    if (procQuitados.length) antes.procesosQuitados = procQuitados.map(_proc);

    // --- Guarda: el pedido sigue existiendo, ninguna sublínea que se quita
    // recibió un EAN y ningún proceso que se quita recibió un registro entre
    // la lectura y el batch. Los procesos nuevos tienen su propia guarda: no
    // cambiaron en el catálogo ---
    const subJson = JSON.stringify(subQuitadas.map((s) => s.sublinea));
    const procJson = JSON.stringify(procQuitados.map((p) => p.nombre));
    let condicion = "NOT EXISTS(SELECT 1 FROM pedidos WHERE numero_pedido = ?)";
    const binds = [pedido];
    if (subQuitadas.length) {
      condicion +=
        " OR EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ? " +
        "AND sublinea IN (SELECT value FROM json_each(?)))";
      binds.push(pedido, subJson);
    }
    if (procQuitados.length) {
      condicion +=
        " OR EXISTS(SELECT 1 FROM registros WHERE numero_pedido = ? " +
        "AND proceso IN (SELECT value FROM json_each(?)))";
      binds.push(pedido, procJson);
    }
    const guardaCatalogo = procNuevos.length
      ? _guardaCatalogo(procNuevos)
      : null;

    const lote = [
      _auditoriaConGuarda(
        env,
        {
          tabla: "pedidos",
          llave: pedido,
          accion: "editar",
          antes,
          despues,
          cedula: sesion.cedula,
          nombre: sesion.nombre || "",
          hechoEn: _ahoraISO(),
        },
        guardaCatalogo
          ? "(" + condicion + ") OR " + guardaCatalogo.condicion
          : condicion,
        guardaCatalogo ? binds.concat(guardaCatalogo.binds) : binds,
      ),
    ];
    if (subQuitadas.length)
      lote.push(
        env.DB.prepare(
          "DELETE FROM pedidos WHERE numero_pedido = ? AND sublinea IN (SELECT value FROM json_each(?))",
        ).bind(pedido, subJson),
      );
    if (datosCambian)
      lote.push(
        env.DB.prepare(
          "UPDATE pedidos SET cliente = ?, evento = ?, clasificacion_proceso = ?, unidades_pedidas = ? " +
            "WHERE numero_pedido = ?",
        ).bind(cliente, evento, clasificacion, unidades, pedido),
      );
    // Las sublíneas nuevas toman la fecha del pedido (la más antigua).
    subNuevas.forEach((s) =>
      lote.push(
        env.DB.prepare(
          "INSERT INTO pedidos (numero_pedido, cliente, sublinea, evento, clasificacion_proceso, fecha, unidades_pedidas) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          pedido,
          cliente,
          s,
          evento,
          clasificacion,
          actual.fecha,
          unidades,
        ),
      ),
    );
    if (procQuitados.length)
      lote.push(
        env.DB.prepare(
          "DELETE FROM procesos WHERE numero_pedido = ? AND nombre_proceso IN (SELECT value FROM json_each(?))",
        ).bind(pedido, JSON.stringify(procQuitados.map((p) => p.nombre))),
      );

    procNuevos.forEach((p) =>
      lote.push(
        env.DB.prepare(
          "INSERT INTO procesos (nombre_proceso, unidades_hora_estandar, numero_pedido, link_procesos) " +
            "VALUES (?, ?, ?, ?)",
        ).bind(p.nombre, p.estandar, pedido, p.link),
      ),
    );
    // Los registros se reescriben en la hoja con la reconciliación de 10 min
    // (anulado_sincronizado_sheets = 0), sin envío inmediato.
    let indiceRegistros = -1;
    if (registrosCambian) {
      indiceRegistros = lote.length;
      lote.push(
        env.DB.prepare(
          "UPDATE registros SET cliente = ?, evento = ?, clasificacion_proceso = ?, " +
            "anulado_sincronizado_sheets = 0 WHERE numero_pedido = ? " +
            "AND (cliente IS NOT ? OR evento IS NOT ? OR clasificacion_proceso IS NOT ?)",
        ).bind(
          cliente,
          evento,
          clasificacion,
          pedido,
          cliente,
          evento,
          clasificacion,
        ),
      );
    }

    let resultados;
    try {
      resultados = await env.DB.batch(lote);
    } catch (errLote) {
      const guarda = await env.DB.prepare(
        "SELECT CASE WHEN " + condicion + " THEN 1 ELSE 0 END AS bloqueado",
      )
        .bind(...binds)
        .first();
      if (guarda && guarda.bloqueado === 1)
        throw new Error(
          "El pedido cambió mientras lo editabas (llegaron EAN o registros, o se eliminó). Vuelve a abrirlo.",
        );
      if (guardaCatalogo) {
        const cambio = await env.DB.prepare(
          "SELECT CASE WHEN " +
            guardaCatalogo.condicion +
            " THEN 1 ELSE 0 END AS si",
        )
          .bind(...guardaCatalogo.binds)
          .first();
        if (cambio && cambio.si === 1) throw new Error(MSG_CATALOGO_CAMBIO);
      }
      throw errLote;
    }
    const registrosActualizados =
      indiceRegistros >= 0
        ? (resultados[indiceRegistros].meta &&
            resultados[indiceRegistros].meta.changes) ||
          0
        : 0;

    // Pedido cerrado: su fila de "Seguimiento paquetes" muestra
    // "Sublínea - Cliente". Si falla, el cambio del pedido ya quedó.
    let seguimientoActualizado = false;
    if (clienteCambia) {
      try {
        const seg = await env.DB.prepare(
          "SELECT vigente FROM seguimiento_paquetes WHERE numero_pedido = ?",
        )
          .bind(pedido)
          .first();
        if (seg && seg.vigente === 1) {
          await _actualizarSeguimientoPedido(env, pedido, true);
          ctx.waitUntil(_pushSeguimientoYMarcar(env, pedido));
          seguimientoActualizado = true;
        }
      } catch (err) {
        console.error(
          "editarPedido: no se pudo refrescar Seguimiento paquetes de " +
            pedido +
            ": " +
            err.message,
        );
      }
    }

    return {
      success: true,
      pedido,
      cambios: {
        datos: datosCambian,
        sublineasAgregadas: subNuevas,
        sublineasQuitadas: subQuitadas.map((s) => s.sublinea),
        procesosAgregados: procNuevos.map((p) => p.nombre),
        procesosQuitados: procQuitados.map((p) => p.nombre),
        registrosActualizados,
      },
      seguimientoActualizado,
    };
  },

  // F3a: los EAN de un pedido y cómo va cada uno, en solo lectura. Las cifras
  // salen de aquí; el frontend no repite ninguna regla.
  // - referente: cuenta para el cierre (_sqlEanReferente). Los demás (EAN 0
  //   sin unidades y sin límite) van aparte.
  // - pendientes: totales − procesadas − sobrantes − justificado, igual que el
  //   techo de la reserva; null si es sin límite. exceso: lo que pasa del total.
  // - desfasado: el estado no corresponde a las unidades (pasa cuando se
  //   cambian las unidades totales en la hoja después de registrar).
  // - registros: todos, anulados incluidos.
  // - Lo ocupado se redondea al entero para decidir si el EAN está lleno,
  //   igual que _recalcularContadorValidacion (F3b).
  // - descuadrado: procesadas o sobrantes no coinciden con los registros
  //   activos (por media unidad o más). desfasado o descuadrado → corregible.
  // - ocupadoRegistros: el mínimo de unidades al editar (F3b).
  async obtenerEanesPedido(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");

    const { results: filasPedido } = await env.DB.prepare(
      "SELECT sublinea, unidades_pedidas AS unidades, tipo FROM pedidos WHERE numero_pedido = ?",
    )
      .bind(pedido)
      .all();
    // En un pedido por etapas, cada fila de etapa lleva el nombre y el orden
    // de su proceso (procesos.etapa_ean).
    const { results: filas } = await env.DB.prepare(
      "SELECT v.ean_producto AS ean, v.sublinea, v.unidades_totales AS totales, " +
        "(SELECT pr.nombre_proceso FROM procesos pr WHERE pr.numero_pedido = v.numero_pedido " +
        "AND pr.etapa_ean = v.ean_producto LIMIT 1) AS etapa, " +
        "(SELECT pr.orden_etapa FROM procesos pr WHERE pr.numero_pedido = v.numero_pedido " +
        "AND pr.etapa_ean = v.ean_producto LIMIT 1) AS ordenEtapa, " +
        "v.sin_limite AS sinLimite, v.unidades_procesadas AS procesadas, " +
        "v.codigos_sobrantes AS sobrantes, COALESCE(v.estado, '') AS estado, " +
        "COALESCE(v.operarios, '') AS operarios, CASE WHEN " +
        _sqlEanReferente("v.") +
        " THEN 1 ELSE 0 END AS referente, " +
        "(SELECT COALESCE(SUM(j.faltante), 0) FROM justificaciones j " +
        "WHERE j.pedido = v.numero_pedido AND j.ean = v.ean_producto) AS justificado, " +
        "(SELECT COUNT(*) FROM registros r WHERE r.numero_pedido = v.numero_pedido " +
        "AND r.ean = v.ean_producto) AS registros, " +
        "(SELECT COALESCE(SUM(r.unidades_procesadas_operario), 0) FROM registros r " +
        "WHERE r.numero_pedido = v.numero_pedido AND r.ean = v.ean_producto AND r.anulado = 0) AS procesadoReg, " +
        "(SELECT COALESCE(SUM(r.codigos_sobrantes), 0) FROM registros r " +
        "WHERE r.numero_pedido = v.numero_pedido AND r.ean = v.ean_producto AND r.anulado = 0) AS sobrantesReg " +
        "FROM validacion_eanes v WHERE v.numero_pedido = ?",
    )
      .bind(pedido)
      .all();
    const just = await env.DB.prepare(
      "SELECT COALESCE(SUM(faltante), 0) AS total FROM justificaciones WHERE pedido = ?",
    )
      .bind(pedido)
      .first();

    if (filasPedido.length === 0 && filas.length === 0)
      throw new Error("El pedido " + pedido + " no existe.");

    const sublineas = _distintos(filasPedido.map((f) => String(f.sublinea)));
    const enPedido = new Set(sublineas.map((s) => _normalizarPedido(s)));
    const porEtapas = filasPedido.some((f) => f.tipo === "etapas");
    const unidadesPedidas = Math.max(
      0,
      ...filasPedido.map((f) => Number(f.unidades) || 0),
    );
    const _orden = (a, b) =>
      String(a).localeCompare(String(b), "es", { numeric: true });
    sublineas.sort(_orden);

    const eanes = filas.map((f) => {
      const sinLimite = f.sinLimite === 1;
      const totales = Number(f.totales) || 0;
      const procesadas = Number(f.procesadas) || 0;
      const sobrantes = Number(f.sobrantes) || 0;
      const justificado = Number(f.justificado) || 0;
      const ocupado = procesadas + sobrantes + justificado;
      const lleno = Math.round(ocupado) >= totales;
      const procesadoReg = Number(f.procesadoReg) || 0;
      const sobrantesReg = Number(f.sobrantesReg) || 0;
      const descuadrado =
        Math.abs(procesadas - procesadoReg) >= 0.5 ||
        Math.abs(sobrantes - sobrantesReg) >= 0.5;
      const referente = f.referente === 1;
      // Mismo criterio que Seguimiento: un estado vacío (EAN que llegó de la
      // hoja y aún no se tocó) se muestra según sus unidades.
      const estado =
        String(f.estado) ||
        (procesadas + sobrantes > 0 ? "En proceso" : "Pendiente");
      const desfasado =
        referente && !sinLimite && (estado === "Completado") !== lleno;
      return {
        ean: String(f.ean),
        etapa: f.etapa ? String(f.etapa) : "",
        ordenEtapa: Number(f.ordenEtapa) || 0,
        sublinea: String(f.sublinea || ""),
        sublineaEnPedido: enPedido.has(_normalizarPedido(f.sublinea)),
        referente,
        sinLimite,
        totales,
        procesadas: _redondear2(procesadas),
        sobrantes,
        justificado: _redondear2(justificado),
        pendientes: sinLimite
          ? null
          : lleno
            ? 0
            : _redondear2(Math.max(0, totales - ocupado)),
        exceso: sinLimite ? 0 : Math.max(0, Math.round(ocupado) - totales),
        estado,
        desfasado,
        descuadrado,
        corregible: desfasado || descuadrado,
        ocupadoRegistros: Math.round(procesadoReg + sobrantesReg + justificado),
        registros: Number(f.registros) || 0,
        operarios: String(f.operarios),
      };
    });
    // Por etapas: en el orden de las etapas, con el EAN 0 al final.
    eanes.sort(
      porEtapas
        ? (a, b) =>
            (a.ordenEtapa || Infinity) - (b.ordenEtapa || Infinity) ||
            _orden(a.ean, b.ean)
        : (a, b) => _orden(a.sublinea, b.sublinea) || _orden(a.ean, b.ean),
    );

    const referentes = eanes.filter((e) => e.referente);
    const _suma = (campo) =>
      _redondear2(referentes.reduce((s, e) => s + (e[campo] || 0), 0));
    const justificado = _redondear2(Number(just && just.total) || 0);
    const cerrado =
      referentes.length > 0 &&
      referentes.every((e) => e.estado === "Completado");

    const alertas = [];
    if (filasPedido.length === 0)
      alertas.push("Existe solo en Validación eanes: falta en Numero pedidos.");
    else
      _distintos(
        eanes.filter((e) => !e.sublineaEnPedido).map((e) => e.sublinea),
      ).forEach((s) =>
        alertas.push(
          'Hay EAN con la sublínea "' + s + '", que no está en Numero pedidos.',
        ),
      );
    // Por etapas cada etapa lleva las unidades pedidas: la suma no aplica.
    if (eanes.length && !porEtapas) {
      const sumaEan = _alertaSumaEan(_suma("totales"), unidadesPedidas);
      if (sumaEan) alertas.push(sumaEan);
    }
    const desfasados = eanes.filter((e) => e.desfasado).length;
    if (desfasados)
      alertas.push(
        (desfasados === 1
          ? "1 EAN tiene un estado que no corresponde"
          : desfasados + " EAN tienen un estado que no corresponde") +
          " a sus unidades (cambiaron las unidades totales después de registrar).",
      );
    const descuadrados = eanes.filter((e) => e.descuadrado).length;
    if (descuadrados)
      alertas.push(
        (descuadrados === 1 ? "1 EAN tiene" : descuadrados + " EAN tienen") +
          " procesadas o sobrantes que no coinciden con sus registros.",
      );
    const conExceso = eanes.filter((e) => e.exceso > 0).length;
    if (conExceso)
      alertas.push(
        (conExceso === 1 ? "1 EAN tiene" : conExceso + " EAN tienen") +
          " más unidades registradas que su total.",
      );
    eanes
      .filter((e) => e.sinLimite && /[^0]/.test(e.ean))
      .forEach((e) =>
        alertas.push(
          "El EAN " +
            e.ean +
            " es sin límite: no cuenta para el cierre. Revisa si es un olvido.",
        ),
      );

    return {
      success: true,
      pedido,
      soloEnValidacion: filasPedido.length === 0,
      porEtapas,
      sublineas,
      unidadesPedidas,
      resumen: {
        eanes: eanes.length,
        referentes: referentes.length,
        aparte: eanes.length - referentes.length,
        unidadesEan: _suma("totales"),
        procesadas: _suma("procesadas"),
        pendientes: _suma("pendientes"),
        justificado,
      },
      cerrado,
      // Con justificación el pedido quedó en "No cumple": sus EAN no se
      // cambian desde la app (F3b), porque la justificación ya no cuadraría.
      conJustificacion: justificado > 0,
      estadoPedido: cerrado
        ? justificado > 0
          ? "No cumple"
          : "Cumple"
        : _suma("procesadas") + _suma("sobrantes") > 0
          ? "En proceso"
          : "Pendiente",
      eanes,
      alertas,
      // F3b: con justificación o solo en Validación no se toca nada.
      // Agregar, editar y eliminar además esperan el interruptor
      // (edicionHabilitada); Corregir no.
      editable: justificado === 0 && filasPedido.length > 0,
      edicionHabilitada: await _edicionHabilitada(env, ["pedidos"]),
    };
  },

  // F3b: agrega (eanOriginal vacío) o edita un EAN del pedido.
  // datos: { pedido, eanOriginal, ean, sublinea, unidades, sinLimite,
  //   efectoAceptado }
  // - El EAN se guarda como se escribió o escaneó y no puede repetirse en el
  //   pedido (ver _mismoEan). El EAN 0 va como "0" y hay uno solo por pedido.
  // - La sublínea se elige entre las del pedido.
  // - Unidades enteras: un EAN real lleva 1 o más; el EAN 0, 0 o más. Sin
  //   límite guarda 0 unidades.
  // - Con registros (anulados incluidos) no cambian el código ni la sublínea,
  //   y las unidades no bajan de lo ocupado en los registros activos.
  // - Si el cambio cierra o reabre el pedido y efectoAceptado no lo dice,
  //   responde { confirmar: "cierra" | "reabre" } sin escribir: el frontend
  //   avisa y vuelve a enviar con efectoAceptado.
  // - Sin cambios (o un agregar repetido con los mismos valores, como un
  //   reintento tras un error de red) responde éxito sin escribir.
  // Al editar, el contador se recalcula desde los registros en el mismo
  // batch. Un EAN nuevo nace sin estado (cuenta como pendiente).
  async guardarEan(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    if (await _esPedidoPorEtapas(env, pedido))
      throw new Error(MSG_PEDIDO_ETAPAS_EAN);
    await _exigirCatalogoEnApp(env, "pedidos");
    const estado = await _estadoEanesPedido(env, pedido);

    const eanOriginal = String(datos.eanOriginal || "").trim();
    const actual = eanOriginal
      ? estado.eanes.find((e) => e.ean === eanOriginal)
      : null;
    if (eanOriginal && !actual)
      throw new Error(
        "El EAN " + eanOriginal + " ya no está en el pedido. Vuelve a abrirlo.",
      );

    let ean = _eanValidado(datos.ean);
    // El mismo código en su otra forma conserva el que ya está guardado.
    if (actual && _mismoEan(ean, actual.ean)) ean = actual.ean;
    const esCero = ean === "0";

    const sublinea = estado.sublineas.find(
      (s) => _normalizarPedido(s) === _normalizarPedido(datos.sublinea),
    );
    if (!sublinea) throw new Error("Elige una sublínea del pedido.");

    const sinLimite = datos.sinLimite === true;
    let totales = 0;
    if (!sinLimite) {
      totales = Number(datos.unidades);
      if (
        datos.unidades === "" ||
        datos.unidades === null ||
        datos.unidades === undefined ||
        !Number.isInteger(totales) ||
        totales < (esCero ? 0 : 1) ||
        totales > MAX_UNIDADES_PEDIDO
      )
        throw new Error(
          esCero
            ? "Las unidades del EAN 0 deben ser un número entero desde 0."
            : "Las unidades deben ser un número entero mayor que 0.",
        );
    }

    const _vista = () => accionesPlaneacion.obtenerEanesPedido({ pedido }, env);
    const repetido = estado.eanes.find(
      (e) => e !== actual && _mismoEan(e.ean, ean),
    );
    if (repetido) {
      const reintento =
        !actual &&
        repetido.ean === ean &&
        repetido.sublinea === sublinea &&
        repetido.totales === totales &&
        repetido.sinLimite === sinLimite;
      if (reintento)
        return {
          success: true,
          pedido,
          ean,
          sinCambios: true,
          efecto: "",
          vista: await _vista(),
        };
      throw new Error(
        esCero
          ? "El pedido ya tiene un EAN 0: solo puede haber uno."
          : "El EAN " + repetido.ean + " ya está en el pedido.",
      );
    }

    if (actual && actual.registros > 0) {
      if (ean !== actual.ean)
        throw new Error(
          "El EAN " +
            actual.ean +
            " tiene registros: no se puede cambiar su código.",
        );
      if (sublinea !== actual.sublinea)
        throw new Error(
          "El EAN " +
            actual.ean +
            " tiene registros: no se puede cambiar su sublínea.",
        );
    }
    const ocupado = actual ? Math.round(actual.ocupado) : 0;
    if (actual && !sinLimite && totales < ocupado)
      throw new Error(
        "El EAN " +
          actual.ean +
          " ya tiene " +
          ocupado +
          " unidades registradas (procesadas y sobrantes): sus unidades no pueden quedar por debajo.",
      );

    if (
      actual &&
      ean === actual.ean &&
      sublinea === actual.sublinea &&
      totales === actual.totales &&
      sinLimite === actual.sinLimite
    )
      return {
        success: true,
        pedido,
        ean,
        sinCambios: true,
        efecto: "",
        vista: await _vista(),
      };

    const cerradoAntes = _pedidoCerrado(estado.eanes);
    const nuevo = {
      ean,
      totales,
      sinLimite,
      estado: actual ? _estadoContador(actual.ocupado, totales, sinLimite) : "",
    };
    const efecto = _efectoCierre(
      cerradoAntes,
      _pedidoCerrado(estado.eanes.filter((e) => e !== actual).concat([nuevo])),
    );
    if (efecto && datos.efectoAceptado !== efecto)
      return { success: true, pedido, ean, confirmar: efecto };

    // Guarda: no llegó una justificación, la sublínea sigue en el pedido y,
    // al editar, el EAN sigue como se leyó, no llegó un registro si cambian el
    // código o la sublínea, y lo ocupado cabe en las unidades nuevas.
    let condicion =
      "EXISTS(SELECT 1 FROM justificaciones WHERE pedido = ?) OR " +
      "NOT EXISTS(SELECT 1 FROM pedidos WHERE numero_pedido = ? AND sublinea = ?)";
    const binds = [pedido, pedido, sublinea];
    if (actual) {
      condicion +=
        " OR NOT EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ? " +
        "AND ean_producto = ? AND sublinea = ? AND unidades_totales = ? AND sin_limite = ?)";
      binds.push(
        pedido,
        actual.ean,
        actual.sublinea,
        actual.totales,
        actual.sinLimite ? 1 : 0,
      );
      if (ean !== actual.ean || sublinea !== actual.sublinea) {
        condicion +=
          " OR EXISTS(SELECT 1 FROM registros WHERE numero_pedido = ? AND ean = ?)";
        binds.push(pedido, actual.ean);
      }
      if (!sinLimite) {
        condicion +=
          " OR ROUND((SELECT COALESCE(SUM(unidades_procesadas_operario + codigos_sobrantes), 0) " +
          "FROM registros WHERE numero_pedido = ? AND ean = ? AND anulado = 0), 0) > ?";
        binds.push(pedido, actual.ean, totales);
      }
    }

    const ahora = _ahoraISO();
    const lote = [
      _auditoriaConGuarda(
        env,
        {
          tabla: "validacion_eanes",
          llave: pedido,
          accion: actual ? "editar" : "crear",
          antes: actual
            ? {
                ean: actual.ean,
                sublinea: actual.sublinea,
                unidades: actual.totales,
                sinLimite: actual.sinLimite,
              }
            : undefined,
          despues: { ean, sublinea, unidades: totales, sinLimite },
          cedula: sesion.cedula,
          nombre: sesion.nombre || "",
          hechoEn: ahora,
        },
        condicion,
        binds,
      ),
    ];
    if (actual) {
      lote.push(
        env.DB.prepare(
          "UPDATE validacion_eanes SET ean_producto = ?, sublinea = ?, unidades_totales = ?, " +
            "sin_limite = ?, actualizado_en = ? WHERE numero_pedido = ? AND ean_producto = ?",
        ).bind(
          ean,
          sublinea,
          totales,
          sinLimite ? 1 : 0,
          ahora,
          pedido,
          actual.ean,
        ),
        _sentenciaRecalcularContador(env, pedido, ean),
      );
    } else {
      lote.push(
        env.DB.prepare(
          "INSERT INTO validacion_eanes (numero_pedido, ean_producto, sublinea, unidades_totales, " +
            "sin_limite, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(pedido, ean, sublinea, totales, sinLimite ? 1 : 0, ahora),
      );
    }

    try {
      await env.DB.batch(lote);
    } catch (errLote) {
      throw await _errorBatchEan(
        env,
        errLote,
        condicion,
        binds,
        "El EAN " + ean + " ya está en el pedido.",
      );
    }

    const completo = await _trasCambioEan(env, ctx, pedido);
    return {
      success: true,
      pedido,
      ean,
      efecto: completo === null ? "" : _efectoCierre(cerradoAntes, completo),
      vista: await _vista(),
    };
  },

  // F3b: elimina un EAN sin registros (anulados incluidos). Con soloSimular
  // valida y responde qué pasará con el cierre del pedido, sin borrar.
  async eliminarEan(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    if (await _esPedidoPorEtapas(env, pedido))
      throw new Error(MSG_PEDIDO_ETAPAS_EAN);
    await _exigirCatalogoEnApp(env, "pedidos");
    const estado = await _estadoEanesPedido(env, pedido);
    const ean = String(datos.ean || "").trim();
    const actual = estado.eanes.find((e) => e.ean === ean);
    if (!actual)
      throw new Error(
        "El EAN " + ean + " ya no está en el pedido. Vuelve a abrirlo.",
      );
    if (actual.registros > 0)
      throw new Error(
        "El EAN " +
          ean +
          " tiene " +
          actual.registros +
          (actual.registros === 1 ? " registro" : " registros") +
          ": no se puede eliminar.",
      );

    const cerradoAntes = _pedidoCerrado(estado.eanes);
    const efecto = _efectoCierre(
      cerradoAntes,
      _pedidoCerrado(estado.eanes.filter((e) => e !== actual)),
    );
    if (datos.soloSimular === true)
      return { success: true, pedido, ean, simulacion: true, efecto };

    const condicion =
      "EXISTS(SELECT 1 FROM justificaciones WHERE pedido = ?) OR " +
      "EXISTS(SELECT 1 FROM registros WHERE numero_pedido = ? AND ean = ?)";
    const binds = [pedido, pedido, ean];
    try {
      await env.DB.batch([
        _auditoriaConGuarda(
          env,
          {
            tabla: "validacion_eanes",
            llave: pedido,
            accion: "eliminar",
            antes: {
              ean,
              sublinea: actual.sublinea,
              unidades: actual.totales,
              sinLimite: actual.sinLimite,
            },
            cedula: sesion.cedula,
            nombre: sesion.nombre || "",
            hechoEn: _ahoraISO(),
          },
          condicion,
          binds,
        ),
        env.DB.prepare(
          "DELETE FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?",
        ).bind(pedido, ean),
      ]);
    } catch (errLote) {
      throw await _errorBatchEan(env, errLote, condicion, binds, "");
    }

    const completo = await _trasCambioEan(env, ctx, pedido);
    return {
      success: true,
      pedido,
      ean,
      efecto: completo === null ? "" : _efectoCierre(cerradoAntes, completo),
      vista: await accionesPlaneacion.obtenerEanesPedido({ pedido }, env),
    };
  },

  // F3b: "Corregir" un EAN: vuelve a calcular procesadas, sobrantes,
  // operarios y estado desde sus registros activos (estados desfasados del
  // pendiente 14 y contadores que no cuadran con los registros). No exige el
  // interruptor: el contador es de D1, igual que en Editar registros. Con
  // soloSimular responde cómo quedaría y qué pasará con el cierre del pedido.
  async corregirEan(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    const estado = await _estadoEanesPedido(env, pedido);
    const ean = String(datos.ean || "").trim();
    const actual = estado.eanes.find((e) => e.ean === ean);
    if (!actual)
      throw new Error(
        "El EAN " + ean + " ya no está en el pedido. Vuelve a abrirlo.",
      );

    const antes = {
      procesadas: _redondear2(actual.procesadas),
      sobrantes: actual.sobrantes,
      estado: actual.estado,
    };
    const despues = {
      procesadas: _redondear2(actual.procesadoReg),
      sobrantes: actual.sobrantesReg,
      estado: _estadoContador(actual.ocupado, actual.totales, actual.sinLimite),
    };
    const _vista = () => accionesPlaneacion.obtenerEanesPedido({ pedido }, env);
    if (
      actual.procesadas === actual.procesadoReg &&
      actual.sobrantes === actual.sobrantesReg &&
      actual.estado === despues.estado
    )
      return {
        success: true,
        pedido,
        ean,
        sinCambios: true,
        efecto: "",
        vista: await _vista(),
      };

    const cerradoAntes = _pedidoCerrado(estado.eanes);
    const efecto = _efectoCierre(
      cerradoAntes,
      _pedidoCerrado(
        estado.eanes.map((e) =>
          e === actual ? { ...e, estado: despues.estado } : e,
        ),
      ),
    );
    if (datos.soloSimular === true)
      return {
        success: true,
        pedido,
        ean,
        simulacion: true,
        efecto,
        antes,
        despues,
      };

    const condicion =
      "EXISTS(SELECT 1 FROM justificaciones WHERE pedido = ?) OR " +
      "NOT EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?)";
    const binds = [pedido, pedido, ean];
    try {
      await env.DB.batch([
        _auditoriaConGuarda(
          env,
          {
            tabla: "validacion_eanes",
            llave: pedido,
            accion: "corregir",
            antes: { ean, ...antes },
            despues: { ean, ...despues },
            cedula: sesion.cedula,
            nombre: sesion.nombre || "",
            hechoEn: _ahoraISO(),
          },
          condicion,
          binds,
        ),
        _sentenciaRecalcularContador(env, pedido, ean),
      ]);
    } catch (errLote) {
      throw await _errorBatchEan(env, errLote, condicion, binds, "");
    }

    const completo = await _trasCambioEan(env, ctx, pedido);
    return {
      success: true,
      pedido,
      ean,
      efecto: completo === null ? "" : _efectoCierre(cerradoAntes, completo),
      vista: await _vista(),
    };
  },

  // F3c: pega varios EAN desde Excel (EAN, unidades y sublínea) en un pedido.
  // datos: { pedido, texto, soloSimular, efectoAceptado }
  // - El Worker lee el texto y revisa cada fila con las reglas de guardarEan
  //   (ver _analizarCarga). Sin límite no se carga: se marca con el
  //   formulario, para que una celda vacía nunca vuelva a significar "sin
  //   límite".
  // - soloSimular devuelve la vista previa sin escribir; funciona también
  //   antes del corte. Guardar exige el interruptor y es todo o nada: con una
  //   fila con error no se guarda nada.
  // - Si la carga reabre un pedido cerrado (Cumple), responde
  //   { confirmar: "reabre" } sin escribir, igual que guardarEan.
  // - Si todos los EAN ya están igual (un reintento tras un error de red),
  //   responde sin cambios.
  async cargarEanes(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    if (await _esPedidoPorEtapas(env, pedido))
      throw new Error(MSG_PEDIDO_ETAPAS_EAN);
    const simular = datos.soloSimular === true;
    if (!simular) await _exigirCatalogoEnApp(env, "pedidos");
    const texto = String(datos.texto || "");
    if (texto.length > MAX_LARGO_CARGA)
      throw new Error(
        "El texto pegado es demasiado largo: divide la carga en partes de hasta " +
          MAX_FILAS_CARGA +
          " filas.",
      );
    const estado = await _estadoEanesPedido(env, pedido);
    const { filas, nuevos } = _analizarCarga(texto, pedido, estado);
    const errores = filas.filter((f) => f.estado === "error").length;

    const filaPedido = await env.DB.prepare(
      "SELECT MAX(unidades_pedidas) AS unidades FROM pedidos WHERE numero_pedido = ?",
    )
      .bind(pedido)
      .first();
    const unidadesPedidas = Number(filaPedido && filaPedido.unidades) || 0;
    const agregados = nuevos.map((n) => ({
      ean: n.ean,
      sinLimite: false,
      totales: n.unidades,
      estado: "",
    }));
    const _sumaReferentes = (lista) =>
      _redondear2(
        lista
          .filter((e) => _esEanReferente(e.ean, e.sinLimite, e.totales))
          .reduce((s, e) => s + e.totales, 0),
      );
    const sumaDespues = _sumaReferentes(estado.eanes.concat(agregados));
    const cerradoAntes = _pedidoCerrado(estado.eanes);
    const efecto = errores
      ? ""
      : _efectoCierre(
          cerradoAntes,
          _pedidoCerrado(estado.eanes.concat(agregados)),
        );
    const resumen = {
      filas: filas.length,
      nuevos: nuevos.length,
      iguales: filas.filter((f) => f.estado === "igual").length,
      errores,
      unidadesNuevas: nuevos.reduce((s, n) => s + n.unidades, 0),
      sumaEanAntes: _sumaReferentes(estado.eanes),
      sumaEanDespues: sumaDespues,
      unidadesPedidas,
      alertaSuma: _alertaSumaEan(sumaDespues, unidadesPedidas),
    };
    if (simular)
      return {
        success: true,
        pedido,
        simulacion: true,
        filas,
        resumen,
        efecto,
        guardable: errores === 0 && nuevos.length > 0,
        edicionHabilitada: await _edicionHabilitada(env, ["pedidos"]),
      };

    if (errores)
      throw new Error(
        (errores === 1 ? "1 fila tiene" : errores + " filas tienen") +
          " error: revisa la vista previa. No se guardó nada.",
      );
    const _vista = () => accionesPlaneacion.obtenerEanesPedido({ pedido }, env);
    if (nuevos.length === 0)
      return {
        success: true,
        pedido,
        sinCambios: true,
        agregados: 0,
        omitidos: resumen.iguales,
        efecto: "",
        vista: await _vista(),
      };
    if (efecto && datos.efectoAceptado !== efecto)
      return { success: true, pedido, confirmar: efecto };

    // Guarda: no llegó una justificación, las sublíneas siguen en el pedido y
    // ningún EAN de la carga (en ninguna de sus formas) apareció entre la
    // lectura y la escritura.
    const sublineas = _distintos(nuevos.map((n) => n.sublinea));
    const formas = _distintos(
      nuevos.flatMap((n) => _formasEan(n.ean).map((f) => f.toUpperCase())),
    );
    const condicion =
      "EXISTS(SELECT 1 FROM justificaciones WHERE pedido = ?) OR " +
      "EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ? " +
      "AND UPPER(ean_producto) IN (SELECT value FROM json_each(?))) OR " +
      "(SELECT COUNT(DISTINCT sublinea) FROM pedidos WHERE numero_pedido = ? " +
      "AND sublinea IN (SELECT value FROM json_each(?))) < ?";
    const binds = [
      pedido,
      pedido,
      JSON.stringify(formas),
      pedido,
      JSON.stringify(sublineas),
      sublineas.length,
    ];
    const lista = nuevos.map((n) => ({
      ean: n.ean,
      sublinea: n.sublinea,
      unidades: n.unidades,
    }));
    const ahora = _ahoraISO();
    try {
      await env.DB.batch([
        _auditoriaConGuarda(
          env,
          {
            tabla: "validacion_eanes",
            llave: pedido,
            accion: "cargar",
            despues: { eanes: lista },
            cedula: sesion.cedula,
            nombre: sesion.nombre || "",
            hechoEn: ahora,
          },
          condicion,
          binds,
        ),
        env.DB.prepare(
          "INSERT INTO validacion_eanes (numero_pedido, ean_producto, sublinea, unidades_totales, " +
            "sin_limite, actualizado_en) SELECT ?, json_extract(value, '$.ean'), " +
            "json_extract(value, '$.sublinea'), json_extract(value, '$.unidades'), 0, ? " +
            "FROM json_each(?)",
        ).bind(pedido, ahora, JSON.stringify(lista)),
      ]);
    } catch (errLote) {
      throw await _errorBatchEan(
        env,
        errLote,
        condicion,
        binds,
        "Uno de los EAN de la carga ya está en el pedido. Vuelve a revisarla.",
      );
    }

    const completo = await _trasCambioEan(env, ctx, pedido);
    return {
      success: true,
      pedido,
      agregados: nuevos.length,
      omitidos: resumen.iguales,
      efecto: completo === null ? "" : _efectoCierre(cerradoAntes, completo),
      vista: await _vista(),
    };
  },
};

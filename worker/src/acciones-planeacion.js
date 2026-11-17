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
} from "./d1-negocio.js";
import { _pushSeguimientoYMarcar } from "./push-sheets.js";

// Procesos sin estándar que llevan casi todos los pedidos: el formulario los
// trae ya marcados (se pueden quitar). No cuentan para el número del pedido.
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

// Catálogo de procesos agrupado por nombre normalizado. Nombre canónico: la
// escritura más usada. Estándar y link: los del pedido más reciente que lo usó
// (por fecha del pedido; empate, la fila más nueva).
async function _catalogoProcesos(env) {
  const { results } = await env.DB.prepare(
    "SELECT pr.id, pr.nombre_proceso AS nombre, pr.unidades_hora_estandar AS estandar, " +
      "COALESCE(pr.link_procesos, '') AS link, COALESCE(f.fecha, '') AS fecha " +
      "FROM procesos pr LEFT JOIN (SELECT numero_pedido, MIN(fecha) AS fecha " +
      "FROM pedidos GROUP BY numero_pedido) f ON f.numero_pedido = pr.numero_pedido",
  ).all();

  const grupos = new Map();
  results.forEach((r) => {
    const nombre = String(r.nombre || "").trim();
    const clave = _normalizarPedido(nombre);
    if (!clave) return;
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        escrituras: new Map(),
        estandares: new Map(),
        reciente: null,
        usos: 0,
      });
    }
    const g = grupos.get(clave);
    g.usos++;
    g.escrituras.set(nombre, (g.escrituras.get(nombre) || 0) + 1);
    const estandar = Number(r.estandar) || 0;
    g.estandares.set(estandar, (g.estandares.get(estandar) || 0) + 1);
    const masNuevo =
      !g.reciente ||
      String(r.fecha) > String(g.reciente.fecha) ||
      (String(r.fecha) === String(g.reciente.fecha) && r.id > g.reciente.id);
    if (masNuevo) g.reciente = r;
  });

  const catalogo = new Map();
  grupos.forEach((g, clave) => {
    const nombre = [...g.escrituras.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"),
    )[0][0];
    catalogo.set(clave, {
      nombre,
      estandar: Number(g.reciente.estandar) || 0,
      link: String(g.reciente.link || ""),
      usos: g.usos,
      // Estándares usados, el más frecuente primero.
      estandares: [...g.estandares.entries()]
        .sort((a, b) => b[1] - a[1] || b[0] - a[0])
        .map((e) => e[0]),
    });
  });
  return catalogo;
}

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

// Valida un proceso del formulario: nombre, estándar (obligatorio, desde 0) y
// link (vacío o http(s)://). Si el nombre ya está en el catálogo devuelve su
// escritura. La repetición dentro del pedido la revisa quien llama.
function _procesoValidado(p, catalogo) {
  const texto = _limpiar(p && p.nombre);
  const clave = _normalizarPedido(texto);
  if (!clave) throw new Error("Hay un proceso sin nombre.");
  if (texto.length > 300)
    throw new Error("Un nombre de proceso pasa de 300 caracteres.");
  const estandar = _redondear2(p.estandar);
  if (
    p.estandar === "" ||
    p.estandar === null ||
    !Number.isFinite(estandar) ||
    estandar < 0 ||
    estandar > 100000
  )
    throw new Error(
      'El estándar de "' + texto + '" debe ser un número desde 0.',
    );
  const link = String((p && p.link) || "").trim();
  if (link && (!/^https?:\/\/\S+$/i.test(link) || link.length > 1000))
    throw new Error(
      'El link de "' + texto + '" debe empezar por http:// o https://.',
    );
  const enCatalogo = catalogo.get(clave);
  return {
    clave,
    nombre: enCatalogo ? enCatalogo.nombre : texto,
    estandar,
    link,
    nuevo: !enCatalogo,
  };
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

export const accionesPlaneacion = {
  // Una entrada por número de pedido con sus sublíneas, cuántos EAN tiene cada
  // una y si el pedido ya tiene registros (en F2b decide qué se puede editar o
  // borrar). Incluye los pedidos que solo existen en Validación eanes.
  async obtenerPedidosPlaneacion(datos, env) {
    const { results: filas } = await env.DB.prepare(
      "SELECT p.numero_pedido AS pedido, p.sublinea, p.cliente, p.evento, " +
        "p.clasificacion_proceso AS clasificacion, p.fecha, p.unidades_pedidas AS unidadesPedidas, " +
        "EXISTS(SELECT 1 FROM registros r WHERE r.numero_pedido = p.numero_pedido) AS conRegistros " +
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
          unidadesPedidas: 0,
          unidadesEan: 0,
        });
      }
      return porPedido.get(pedido);
    };

    filas.forEach((f) => {
      const e = _entrada(f.pedido);
      e.conRegistros = e.conRegistros || f.conRegistros === 1;
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
        const sumaEan = nEanes
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
  // que la misma acción sirve antes y después del corte.
  async obtenerClientesPlaneacion(datos, env) {
    const { results: usados } = await env.DB.prepare(
      "SELECT cliente, COUNT(DISTINCT numero_pedido) AS pedidos FROM pedidos GROUP BY cliente",
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
      _grupo(nombre).variantes.push({ nombre, pedidos: u.pedidos });
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

    const catalogo = await _catalogoProcesos(env);
    const procesos = [...catalogo.values()].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, "es"),
    );
    const generales = PROCESOS_GENERALES.map((nombre) => {
      const c = catalogo.get(_normalizarPedido(nombre));
      return c
        ? { nombre: c.nombre, estandar: c.estandar, link: c.link }
        : { nombre, estandar: 0, link: "" };
    });
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
  // datos: { idEnvio, tipo: "pedido"|"interna", unidades, nombre, cliente,
  //   sublineas[], evento, clasificacion, procesos[{nombre, estandar, link}],
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
      if (!interna && datos.tipo !== "pedido")
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

      // --- Procesos: nombre del catálogo si ya existe ---
      const catalogo = await _catalogoProcesos(env);
      const procesos = [];
      const vistosProc = new Set();
      (Array.isArray(datos.procesos) ? datos.procesos : []).forEach((p) => {
        const clave = _normalizarPedido(_limpiar(p && p.nombre));
        if (clave && vistosProc.has(clave))
          throw new Error(
            'El proceso "' + _limpiar(p.nombre) + '" está repetido.',
          );
        const v = _procesoValidado(p, catalogo);
        vistosProc.add(v.clave);
        procesos.push({
          nombre: v.nombre,
          estandar: v.estandar,
          link: v.link,
          nuevo: v.nuevo,
        });
      });
      if (procesos.length === 0) throw new Error("Agrega al menos un proceso.");
      if (procesos.length > MAX_PROCESOS)
        throw new Error("Máximo " + MAX_PROCESOS + " procesos por pedido.");

      const sinLimite = interna && datos.sinLimite === true;
      const fecha = _fechaHoyBogota();
      const ahora = _ahoraISO();

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
          tipo: interna ? "interna" : "pedido",
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
              "EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ?)",
            [pedido, pedido],
          ),
        ];
        sublineas.forEach((s) =>
          lote.push(
            env.DB.prepare(
              "INSERT INTO pedidos (numero_pedido, cliente, sublinea, evento, clasificacion_proceso, fecha, unidades_pedidas) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).bind(
              pedido,
              cliente.nombre,
              s,
              evento,
              clasificacion,
              fecha,
              unidades,
            ),
          ),
        );
        procesos.forEach((p) =>
          lote.push(
            env.DB.prepare(
              "INSERT INTO procesos (nombre_proceso, unidades_hora_estandar, numero_pedido, link_procesos) " +
                "VALUES (?, ?, ?, ?)",
            ).bind(p.nombre, p.estandar, pedido, p.link),
          ),
        );
        // Sin límite: EAN 0 (trabajo sin unidades estimadas) en la primera
        // sublínea. No es referente: no cuenta para el cierre del pedido.
        if (sinLimite) {
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
            procesosNuevos: procesos.filter((p) => p.nuevo).length,
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
          if (!tomado) throw errLote;
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

  // Clientes: crear, desactivar o reactivar. Un cliente no se borra: si deja
  // de usarse se desactiva y sale del selector del formulario.
  // datos: { accion: "crear"|"desactivar"|"reactivar", nombre }
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

    throw new Error("Acción de cliente no válida.");
  },

  // F2b-2: datos para editar un pedido (su estado actual con lo que bloquea
  // cada sublínea y proceso) más los catálogos del formulario de crear.
  async obtenerPedidoParaEditar(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    const estado = await _estadoPedido(env, pedido);
    if (!estado.existe) throw _errorPedidoNoEditable(pedido, estado);
    const formulario = await accionesPlaneacion.obtenerFormularioPedido(
      {},
      env,
    );
    delete formulario.success;
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
        procesos: estado.procesos,
        huella: estado.huella,
      },
    };
  },

  // Edita un pedido. Recibe cómo debe quedar y el Worker calcula qué cambió:
  // - cliente, evento y clasificación van a todas las sublíneas y a sus
  //   registros (la hoja Registros se pone al día con la reconciliación);
  // - sublíneas: se agregan siempre; se quitan solo sin EAN;
  // - procesos: se agregan siempre; se ajustan o quitan solo sin registros;
  // - unidades pedidas: solo si el pedido viene de la hoja y las tiene en 0.
  // Sin cambios responde éxito (sirve también para un reintento tras un error
  // de red). Si el pedido cambió desde que se abrió (huella distinta), no
  // guarda. Si el pedido está cerrado y cambió el cliente, refresca su fila de
  // "Seguimiento paquetes".
  // datos: { pedido, huella, cliente, evento, clasificacion, unidades,
  //   sublineas[], procesos[{nombre, estandar, link}] }
  async editarPedido(datos, env, ctx, ip, sesion) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");
    await _exigirCatalogoEnApp(env, "pedidos");
    await _exigirCatalogoEnApp(env, "procesos");

    const actual = await _estadoPedido(env, pedido);
    if (!actual.existe) throw _errorPedidoNoEditable(pedido, actual);

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
    // Uno que ya está en el pedido y llega igual se deja tal cual, sin
    // revalidar (puede traer un link viejo de la hoja).
    const catalogo = await _catalogoProcesos(env);
    const procActuales = new Map(
      actual.procesos.map((p) => [_normalizarPedido(p.nombre), p]),
    );
    const procesos = []; // { nombre, estandar, link, estado, antes }
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
        const link = String(p.link || "").trim();
        const igual =
          link === existente.link &&
          p.estandar !== "" &&
          p.estandar !== null &&
          _redondear2(p.estandar) === _redondear2(existente.estandar);
        if (igual) {
          procesos.push({ ...existente, estado: "igual" });
          return;
        }
        if (existente.registros > 0)
          throw new Error(
            'El proceso "' +
              existente.nombre +
              '" tiene registros: no se puede cambiar su estándar ni su link.',
          );
        const v = _procesoValidado(p, catalogo);
        procesos.push({
          nombre: existente.nombre,
          estandar: v.estandar,
          link: v.link,
          estado: "ajustado",
          antes: existente,
        });
        return;
      }
      const v = _procesoValidado(p, catalogo);
      vistosProc.add(v.clave);
      procesos.push({
        nombre: v.nombre,
        estandar: v.estandar,
        link: v.link,
        estado: "nuevo",
      });
    });
    if (procesos.length === 0)
      throw new Error("El pedido debe tener al menos un proceso.");
    if (procesos.length > MAX_PROCESOS)
      throw new Error("Máximo " + MAX_PROCESOS + " procesos por pedido.");
    const procNuevos = procesos.filter((p) => p.estado === "nuevo");
    const procAjustados = procesos.filter((p) => p.estado === "ajustado");
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
      procAjustados.length > 0 ||
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
    if (procAjustados.length) {
      antes.procesosAjustados = procAjustados.map((p) => _proc(p.antes));
      despues.procesosAjustados = procAjustados.map(_proc);
    }
    if (procQuitados.length) antes.procesosQuitados = procQuitados.map(_proc);

    // --- Guarda: el pedido sigue existiendo, ninguna sublínea que se quita
    // recibió un EAN y ningún proceso que se quita o ajusta recibió un
    // registro entre la lectura y el batch ---
    const subJson = JSON.stringify(subQuitadas.map((s) => s.sublinea));
    const procBloqueables = procQuitados
      .map((p) => p.nombre)
      .concat(procAjustados.map((p) => p.nombre));
    const procJson = JSON.stringify(procBloqueables);
    let condicion = "NOT EXISTS(SELECT 1 FROM pedidos WHERE numero_pedido = ?)";
    const binds = [pedido];
    if (subQuitadas.length) {
      condicion +=
        " OR EXISTS(SELECT 1 FROM validacion_eanes WHERE numero_pedido = ? " +
        "AND sublinea IN (SELECT value FROM json_each(?)))";
      binds.push(pedido, subJson);
    }
    if (procBloqueables.length) {
      condicion +=
        " OR EXISTS(SELECT 1 FROM registros WHERE numero_pedido = ? " +
        "AND proceso IN (SELECT value FROM json_each(?)))";
      binds.push(pedido, procJson);
    }

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
        condicion,
        binds,
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
    procAjustados.forEach((p) =>
      lote.push(
        env.DB.prepare(
          "UPDATE procesos SET unidades_hora_estandar = ?, link_procesos = ? " +
            "WHERE numero_pedido = ? AND nombre_proceso = ?",
        ).bind(p.estandar, p.link, pedido, p.nombre),
      ),
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
        procesosAjustados: procAjustados.map((p) => p.nombre),
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
  async obtenerEanesPedido(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    if (!pedido) throw new Error("Falta el número de pedido.");

    const { results: filasPedido } = await env.DB.prepare(
      "SELECT sublinea, unidades_pedidas AS unidades FROM pedidos WHERE numero_pedido = ?",
    )
      .bind(pedido)
      .all();
    const { results: filas } = await env.DB.prepare(
      "SELECT v.ean_producto AS ean, v.sublinea, v.unidades_totales AS totales, " +
        "v.sin_limite AS sinLimite, v.unidades_procesadas AS procesadas, " +
        "v.codigos_sobrantes AS sobrantes, COALESCE(v.estado, '') AS estado, " +
        "COALESCE(v.operarios, '') AS operarios, CASE WHEN " +
        _sqlEanReferente("v.") +
        " THEN 1 ELSE 0 END AS referente, " +
        "(SELECT COALESCE(SUM(j.faltante), 0) FROM justificaciones j " +
        "WHERE j.pedido = v.numero_pedido AND j.ean = v.ean_producto) AS justificado, " +
        "(SELECT COUNT(*) FROM registros r WHERE r.numero_pedido = v.numero_pedido " +
        "AND r.ean = v.ean_producto) AS registros " +
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
      const lleno = ocupado >= totales;
      const referente = f.referente === 1;
      // Mismo criterio que Seguimiento: un estado vacío (EAN que llegó de la
      // hoja y aún no se tocó) se muestra según sus unidades.
      const estado =
        String(f.estado) ||
        (procesadas + sobrantes > 0 ? "En proceso" : "Pendiente");
      return {
        ean: String(f.ean),
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
          : _redondear2(Math.max(0, totales - ocupado)),
        exceso: sinLimite ? 0 : _redondear2(Math.max(0, ocupado - totales)),
        estado,
        desfasado:
          referente && !sinLimite && (estado === "Completado") !== lleno,
        registros: Number(f.registros) || 0,
        operarios: String(f.operarios),
      };
    });
    eanes.sort(
      (a, b) => _orden(a.sublinea, b.sublinea) || _orden(a.ean, b.ean),
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
    if (eanes.length) {
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
      edicionHabilitada: await _edicionHabilitada(env, ["pedidos"]),
    };
  },
};

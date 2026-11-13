// Acciones del rol Planeación: los módulos que reemplazan las hojas de
// catálogo. Todas van en PERMISOS_POR_ACCION de index.js como ["planeacion"]:
// exigen esa sesión también en modo mixto.
// F2a (solo lectura): Pedidos y Clientes.
// F2b-1: crear y eliminar pedidos, y crear/desactivar/reactivar clientes. Las
// escrituras exigen el interruptor (_exigirCatalogoEnApp): hasta el corte F4
// quedan bloqueadas y las hojas siguen mandando.

import {
  _normalizarPedido,
  _exigirCatalogoEnApp,
  _huellaPayload,
  _chequearIdempotencia,
  _confirmarIdempotencia,
  _liberarIdempotencia,
  _fechaHoyBogota,
  _ahoraISO,
} from "./d1-negocio.js";

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

export const accionesPlaneacion = {
  // Una entrada por número de pedido con sus sublíneas, cuántos EAN tiene cada
  // una y si el pedido ya tiene registros (en F2b decide qué se puede editar o
  // borrar). Incluye los pedidos que solo existen en Validación eanes.
  async obtenerPedidosPlaneacion(datos, env) {
    const { results: filas } = await env.DB.prepare(
      "SELECT p.numero_pedido AS pedido, p.sublinea, p.cliente, p.evento, " +
        "p.clasificacion_proceso AS clasificacion, p.fecha, " +
        "EXISTS(SELECT 1 FROM registros r WHERE r.numero_pedido = p.numero_pedido) AS conRegistros " +
        "FROM pedidos p",
    ).all();
    const { results: eanes } = await env.DB.prepare(
      "SELECT v.numero_pedido AS pedido, v.sublinea, COUNT(*) AS eanes, " +
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
        });
      }
      return porPedido.get(pedido);
    };

    filas.forEach((f) => {
      const e = _entrada(f.pedido);
      e.conRegistros = e.conRegistros || f.conRegistros === 1;
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
        eanes: e.sublineas.reduce((s, x) => s + x.eanes, 0),
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
        const texto = _limpiar(p && p.nombre);
        const clave = _normalizarPedido(texto);
        if (!clave) throw new Error("Hay un proceso sin nombre.");
        if (texto.length > 300)
          throw new Error("Un nombre de proceso pasa de 300 caracteres.");
        if (vistosProc.has(clave))
          throw new Error('El proceso "' + texto + '" está repetido.');
        vistosProc.add(clave);
        const estandar = Math.round(Number(p.estandar) * 100) / 100;
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
        procesos.push({
          nombre: enCatalogo ? enCatalogo.nombre : texto,
          estandar,
          link,
          nuevo: !enCatalogo,
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
};

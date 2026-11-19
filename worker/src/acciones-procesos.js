// Módulo Procesos del rol Planeación (F5): el catálogo de procesos. Todas las
// acciones van en PERMISOS_POR_ACCION de index.js como ["planeacion"].
//
// Un proceso es único: un nombre específico con su estándar y su link (si
// hay), y se asigna a los pedidos que lo necesiten. La tabla `procesos` sigue
// siendo la asignación proceso-pedido (la hoja repetía el proceso en una fila
// por pedido); su estándar y su link pasan a ser copia del catálogo.
//
// P1 (funciona antes del corte, sin interruptor: el pull no toca
// catalogo_procesos): ver el catálogo y los procesos que se usan en los
// pedidos pero no están en él; crear, editar, marcar como general, desactivar,
// eliminar (inactivo y sin uso) y agregar al catálogo los que están en uso.
// Lo que se cambia aquí todavía no llega a los pedidos: eso va con el
// interruptor `procesos` (corte único de F4).

import {
  _normalizarPedido,
  _exigirCatalogoEnApp,
  _ahoraISO,
} from "./d1-negocio.js";
import { PROCESOS_GENERALES } from "./acciones-planeacion.js";

const MAX_ESTANDAR = 100000;
const MAX_LARGO_NOMBRE = 300;
const MAX_LARGO_LINK = 1000;
const MAX_IDS_BLOQUE = 1000;

function _limpiar(texto) {
  return String(texto || "")
    .trim()
    .replace(/\s+/g, " ");
}

function _redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function _linkValido(link) {
  return !link || /^https?:\/\/\S+$/i.test(link);
}

// Fila de auditoria_catalogos con la cédula y el nombre de la sesión.
function _auditoria(env, sesion, fila) {
  return env.DB.prepare(
    "INSERT INTO auditoria_catalogos (tabla, llave, accion, antes, despues, cedula, nombre, hecho_en) " +
      "VALUES ('catalogo_procesos', ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    fila.llave,
    fila.accion,
    fila.antes === undefined ? null : JSON.stringify(fila.antes),
    fila.despues === undefined ? null : JSON.stringify(fila.despues),
    sesion.cedula,
    sesion.nombre || "",
    _ahoraISO(),
  );
}

// Valida nombre, estándar (obligatorio, desde 0, 2 decimales), link (vacío o
// http(s)://) y general.
function _procesoValidado(datos) {
  const nombre = _limpiar(datos.nombre);
  const clave = _normalizarPedido(nombre);
  if (!clave) throw new Error("Escribe el nombre del proceso.");
  if (nombre.length < 2) throw new Error("El nombre del proceso es muy corto.");
  if (nombre.length > MAX_LARGO_NOMBRE)
    throw new Error(
      "El nombre del proceso pasa de " + MAX_LARGO_NOMBRE + " caracteres.",
    );
  const crudo = datos.estandar;
  const estandar = _redondear2(
    typeof crudo === "string" ? crudo.trim().replace(",", ".") : crudo,
  );
  if (
    crudo === "" ||
    crudo === null ||
    crudo === undefined ||
    (typeof crudo === "string" && !/^\d+([.,]\d+)?$/.test(crudo.trim())) ||
    !Number.isFinite(estandar) ||
    estandar < 0 ||
    estandar > MAX_ESTANDAR
  )
    throw new Error(
      "El estándar debe ser un número desde 0 hasta " + MAX_ESTANDAR + ".",
    );
  const link = String(datos.link || "").trim();
  if (link.length > MAX_LARGO_LINK)
    throw new Error("El link pasa de " + MAX_LARGO_LINK + " caracteres.");
  if (!_linkValido(link))
    throw new Error("El link debe empezar por http:// o https://.");
  if (datos.general !== undefined && typeof datos.general !== "boolean")
    throw new Error("Falta indicar si el proceso es general.");
  return { nombre, clave, estandar, link, general: datos.general === true };
}

// Uso de cada nombre normalizado en los pedidos (tabla procesos) y en los
// registros (anulados incluidos: también guardan el nombre).
async function _usoProcesos(env) {
  const { results: filas } = await env.DB.prepare(
    "SELECT pr.id, pr.nombre_proceso AS nombre, pr.unidades_hora_estandar AS estandar, " +
      "COALESCE(pr.link_procesos, '') AS link, pr.numero_pedido AS pedido, " +
      "COALESCE(f.fecha, '') AS fecha FROM procesos pr LEFT JOIN " +
      "(SELECT numero_pedido, MIN(fecha) AS fecha FROM pedidos GROUP BY numero_pedido) f " +
      "ON f.numero_pedido = pr.numero_pedido",
  ).all();
  const { results: regs } = await env.DB.prepare(
    "SELECT proceso, COUNT(*) AS n, MAX(fecha) AS ultima FROM registros GROUP BY proceso",
  ).all();

  const uso = new Map();
  const grupo = (clave) => {
    if (!uso.has(clave))
      uso.set(clave, {
        escrituras: new Map(),
        estandares: new Map(),
        filas: [],
        pedidos: new Set(),
        registros: 0,
        ultimoUso: "",
        reciente: null,
      });
    return uso.get(clave);
  };
  filas.forEach((r) => {
    const nombre = _limpiar(r.nombre);
    const clave = _normalizarPedido(nombre);
    if (!clave) return;
    const g = grupo(clave);
    g.escrituras.set(nombre, (g.escrituras.get(nombre) || 0) + 1);
    const estandar = _redondear2(Number(r.estandar) || 0);
    g.estandares.set(estandar, (g.estandares.get(estandar) || 0) + 1);
    g.filas.push({ estandar, link: String(r.link || "").trim() });
    g.pedidos.add(String(r.pedido));
    const fecha = String(r.fecha || "");
    if (fecha > g.ultimoUso) g.ultimoUso = fecha;
    const masNuevo =
      !g.reciente ||
      fecha > g.reciente.fecha ||
      (fecha === g.reciente.fecha && r.id > g.reciente.id);
    if (masNuevo)
      g.reciente = {
        id: r.id,
        fecha,
        estandar,
        link: String(r.link || "").trim(),
      };
  });
  // Un nombre que solo queda en registros (su pedido ya no está) también
  // cuenta: un proceso del catálogo con ese nombre no se renombra ni se borra.
  regs.forEach((r) => {
    const clave = _normalizarPedido(r.proceso);
    if (!clave) return;
    const g = grupo(clave);
    g.registros += Number(r.n) || 0;
    const ultima = String(r.ultima || "");
    if (ultima > g.ultimoUso) g.ultimoUso = ultima;
  });

  uso.forEach((g) => {
    g.nombre = g.escrituras.size
      ? [...g.escrituras.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"),
        )[0][0]
      : "";
    // Estándares usados, el más frecuente primero.
    g.listaEstandares = [...g.estandares.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])
      .map((e) => e[0]);
  });
  return uso;
}

async function _procesoPorId(env, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Falta el proceso.");
  const fila = await env.DB.prepare(
    "SELECT id, nombre, clave, estandar, link, general, activo FROM catalogo_procesos WHERE id = ?",
  )
    .bind(n)
    .first();
  if (!fila)
    throw new Error("El proceso ya no está en el catálogo. Recarga la lista.");
  return fila;
}

function _errorUnico(err) {
  return /UNIQUE/i.test(String(err && err.message))
    ? new Error("Ya hay un proceso con ese nombre en el catálogo.")
    : err;
}

function _textoUso(g) {
  const partes = [];
  if (g.pedidos.size)
    partes.push(
      g.pedidos.size + (g.pedidos.size === 1 ? " pedido" : " pedidos"),
    );
  if (g.registros)
    partes.push(g.registros + (g.registros === 1 ? " registro" : " registros"));
  return partes.join(" y ");
}

// Un nombre nuevo (crear o renombrar) no puede ser el de otro proceso del
// catálogo ni el de un proceso que ya se usa fuera de él: ese se agrega desde
// "En uso, fuera del catálogo".
async function _exigirNombreLibre(env, clave, uso, idPropio) {
  const otro = await env.DB.prepare(
    "SELECT id, nombre, activo FROM catalogo_procesos WHERE clave = ?",
  )
    .bind(clave)
    .first();
  if (otro && otro.id !== idPropio)
    throw new Error(
      'Ya está en el catálogo como "' +
        otro.nombre +
        '"' +
        (otro.activo === 1 ? "." : " (inactivo): reactívalo."),
    );
  const g = uso.get(clave);
  if (!otro && g && g.pedidos.size)
    throw new Error(
      'El nombre "' +
        g.nombre +
        '" ya se usa en ' +
        _textoUso(g) +
        ': agrégalo desde "En uso, fuera del catálogo".',
    );
}

export const accionesProcesos = {
  // Todo lo que muestra el módulo, en solo lectura.
  async obtenerProcesosPlaneacion(datos, env) {
    const { results: filas } = await env.DB.prepare(
      "SELECT id, nombre, clave, estandar, link, general, activo, creado_en AS creadoEn, " +
        "actualizado_en AS actualizadoEn FROM catalogo_procesos",
    ).all();
    const uso = await _usoProcesos(env);
    const enCatalogo = new Set();

    const procesos = filas.map((f) => {
      enCatalogo.add(f.clave);
      const g = uso.get(f.clave);
      const estandar = _redondear2(Number(f.estandar) || 0);
      const link = String(f.link || "");
      // Filas de pedidos con otro estándar u otro link que el del catálogo:
      // se igualan cuando el catálogo llegue a los pedidos (corte).
      const distintos = g
        ? g.filas.filter((r) => r.estandar !== estandar || r.link !== link)
            .length
        : 0;
      return {
        id: f.id,
        nombre: String(f.nombre),
        estandar,
        link,
        general: f.general === 1,
        activo: f.activo === 1,
        pedidos: g ? g.pedidos.size : 0,
        registros: g ? g.registros : 0,
        ultimoUso: g ? g.ultimoUso : "",
        estandaresUsados: g ? g.listaEstandares : [],
        escrituras: g ? g.escrituras.size : 0,
        distintos,
        linkValido: _linkValido(link),
      };
    });

    const fueraDelCatalogo = [];
    uso.forEach((g, clave) => {
      if (enCatalogo.has(clave) || !g.pedidos.size) return;
      fueraDelCatalogo.push({
        clave,
        nombre: g.nombre,
        estandar: g.reciente ? g.reciente.estandar : 0,
        link: g.reciente ? g.reciente.link : "",
        pedidos: g.pedidos.size,
        registros: g.registros,
        ultimoUso: g.ultimoUso,
        estandaresUsados: g.listaEstandares,
        escrituras: g.escrituras.size,
        linkValido: _linkValido(g.reciente ? g.reciente.link : ""),
      });
    });

    const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, "es");
    procesos.sort(
      (a, b) => Number(b.activo) - Number(a.activo) || porNombre(a, b),
    );
    fueraDelCatalogo.sort(porNombre);

    let edicionHabilitada = true;
    try {
      await _exigirCatalogoEnApp(env, "procesos");
    } catch (err) {
      edicionHabilitada = false;
    }
    return { success: true, procesos, fueraDelCatalogo, edicionHabilitada };
  },

  // datos: { accion, id, nombre, estandar, link, general, claves, ids }
  // - crear: nombre libre (ni en el catálogo ni en uso fuera de él).
  // - editar: estándar, link y general siempre; el nombre solo si el proceso
  //   no se usa en pedidos ni en registros (hasta que el catálogo llegue a los
  //   pedidos, un nombre en uso no se cambia: se crea uno más específico).
  // - desactivar / reactivar: un proceso inactivo no se ofrece en pedidos
  //   nuevos; los pedidos que ya lo tienen no cambian.
  // - eliminar: solo inactivo y sin uso.
  // - agregarEnUso: agrega al catálogo los procesos en uso que faltan
  //   (`claves`, o todos con `todos: true`) con el nombre más usado y el
  //   estándar y el link del pedido más reciente.
  // - desactivarVarios: desactiva los `ids` (por ejemplo, los que no se usan
  //   hace tiempo).
  async guardarProceso(datos, env, ctx, ip, sesion) {
    const accion = String(datos.accion || "");
    const ahora = _ahoraISO();

    if (accion === "crear") {
      const p = _procesoValidado(datos);
      const uso = await _usoProcesos(env);
      await _exigirNombreLibre(env, p.clave, uso, null);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO catalogo_procesos (nombre, clave, estandar, link, general, activo, creado_en, actualizado_en) " +
              "VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
          ).bind(
            p.nombre,
            p.clave,
            p.estandar,
            p.link,
            p.general ? 1 : 0,
            ahora,
            ahora,
          ),
          _auditoria(env, sesion, {
            llave: p.nombre,
            accion: "crear",
            despues: {
              nombre: p.nombre,
              estandar: p.estandar,
              link: p.link,
              general: p.general,
            },
          }),
        ]);
      } catch (err) {
        throw _errorUnico(err);
      }
      return { success: true, nombre: p.nombre };
    }

    if (accion === "editar") {
      const actual = await _procesoPorId(env, datos.id);
      const p = _procesoValidado(datos);
      const antes = {
        nombre: actual.nombre,
        estandar: _redondear2(Number(actual.estandar) || 0),
        link: String(actual.link || ""),
        general: actual.general === 1,
      };
      const despues = {
        nombre: p.nombre,
        estandar: p.estandar,
        link: p.link,
        general: p.general,
      };
      const cambios = Object.keys(despues).filter(
        (k) => despues[k] !== antes[k],
      );
      if (!cambios.length)
        return { success: true, nombre: actual.nombre, sinCambios: true };
      if (p.nombre !== actual.nombre) {
        const uso = await _usoProcesos(env);
        const g = uso.get(actual.clave);
        if (g && (g.pedidos.size || g.registros))
          throw new Error(
            'El nombre "' +
              actual.nombre +
              '" ya se usa en ' +
              _textoUso(g) +
              ": no se cambia. Si hace falta un nombre más específico, crea otro proceso.",
          );
        if (p.clave !== actual.clave)
          await _exigirNombreLibre(env, p.clave, uso, actual.id);
      }
      const filtro = (o) => Object.fromEntries(cambios.map((k) => [k, o[k]]));
      try {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE catalogo_procesos SET nombre = ?, clave = ?, estandar = ?, link = ?, " +
              "general = ?, actualizado_en = ? WHERE id = ?",
          ).bind(
            p.nombre,
            p.clave,
            p.estandar,
            p.link,
            p.general ? 1 : 0,
            ahora,
            actual.id,
          ),
          _auditoria(env, sesion, {
            llave: actual.nombre,
            accion: "editar",
            antes: filtro(antes),
            despues: filtro(despues),
          }),
        ]);
      } catch (err) {
        throw _errorUnico(err);
      }
      return { success: true, nombre: p.nombre };
    }

    if (accion === "desactivar" || accion === "reactivar") {
      const actual = await _procesoPorId(env, datos.id);
      const activo = accion === "reactivar" ? 1 : 0;
      if (actual.activo === activo)
        return { success: true, nombre: actual.nombre, sinCambios: true };
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE catalogo_procesos SET activo = ?, actualizado_en = ? WHERE id = ?",
        ).bind(activo, ahora, actual.id),
        _auditoria(env, sesion, {
          llave: actual.nombre,
          accion: activo ? "activar" : "desactivar",
          antes: { activo: actual.activo === 1 },
          despues: { activo: activo === 1 },
        }),
      ]);
      return { success: true, nombre: actual.nombre };
    }

    if (accion === "eliminar") {
      const actual = await _procesoPorId(env, datos.id);
      if (actual.activo === 1)
        throw new Error(
          "Primero desactiva el proceso; después se puede eliminar.",
        );
      const uso = await _usoProcesos(env);
      const g = uso.get(actual.clave);
      if (g && (g.pedidos.size || g.registros))
        throw new Error(
          'El proceso "' +
            actual.nombre +
            '" se usa en ' +
            _textoUso(g) +
            ": no se elimina, queda inactivo.",
        );
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM catalogo_procesos WHERE id = ? AND activo = 0",
        ).bind(actual.id),
        _auditoria(env, sesion, {
          llave: actual.nombre,
          accion: "eliminar",
          antes: {
            nombre: actual.nombre,
            estandar: _redondear2(Number(actual.estandar) || 0),
            link: String(actual.link || ""),
            general: actual.general === 1,
          },
        }),
      ]);
      return { success: true, nombre: actual.nombre };
    }

    if (accion === "agregarEnUso") {
      const todos = datos.todos === true;
      const pedidas = Array.isArray(datos.claves)
        ? new Set(datos.claves.map((c) => _normalizarPedido(c)))
        : null;
      if (!todos && (!pedidas || !pedidas.size))
        throw new Error("Elige los procesos que se agregan.");
      const uso = await _usoProcesos(env);
      const { results: existentes } = await env.DB.prepare(
        "SELECT clave FROM catalogo_procesos",
      ).all();
      const yaEstan = new Set(existentes.map((e) => e.clave));
      const generales = new Set(PROCESOS_GENERALES.map(_normalizarPedido));
      const nuevos = [];
      uso.forEach((g, clave) => {
        if (yaEstan.has(clave) || !g.pedidos.size) return;
        if (!todos && !pedidas.has(clave)) return;
        nuevos.push({
          nombre: g.nombre.slice(0, MAX_LARGO_NOMBRE),
          clave,
          estandar: g.reciente ? g.reciente.estandar : 0,
          link: g.reciente ? g.reciente.link.slice(0, MAX_LARGO_LINK) : "",
          general: generales.has(clave) ? 1 : 0,
        });
      });
      if (!nuevos.length)
        return { success: true, agregados: 0, sinCambios: true };
      nuevos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
      const res = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO catalogo_procesos (nombre, clave, estandar, link, general, activo, creado_en, actualizado_en) " +
            "SELECT json_extract(value, '$.nombre'), json_extract(value, '$.clave'), " +
            "json_extract(value, '$.estandar'), json_extract(value, '$.link'), " +
            "json_extract(value, '$.general'), 1, ?, ? FROM json_each(?) WHERE 1 " +
            "ON CONFLICT(clave) DO NOTHING",
        ).bind(ahora, ahora, JSON.stringify(nuevos)),
        _auditoria(env, sesion, {
          llave: todos ? "(todos los en uso)" : nuevos[0].nombre,
          accion: "cargar",
          despues: { procesos: nuevos.map((n) => n.nombre) },
        }),
      ]);
      const agregados =
        res[0] && res[0].meta && Number.isFinite(res[0].meta.changes)
          ? res[0].meta.changes
          : nuevos.length;
      return { success: true, agregados };
    }

    if (accion === "desactivarVarios") {
      const ids = Array.isArray(datos.ids)
        ? [...new Set(datos.ids.map(Number))].filter(
            (n) => Number.isInteger(n) && n > 0,
          )
        : [];
      if (!ids.length) throw new Error("No hay procesos para desactivar.");
      if (ids.length > MAX_IDS_BLOQUE)
        throw new Error(
          "Se desactivan máximo " + MAX_IDS_BLOQUE + " procesos a la vez.",
        );
      const { results: activos } = await env.DB.prepare(
        "SELECT id, nombre FROM catalogo_procesos WHERE activo = 1 AND id IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(ids))
        .all();
      if (!activos.length)
        return { success: true, desactivados: 0, sinCambios: true };
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE catalogo_procesos SET activo = 0, actualizado_en = ? " +
            "WHERE activo = 1 AND id IN (SELECT value FROM json_each(?))",
        ).bind(ahora, JSON.stringify(activos.map((a) => a.id))),
        _auditoria(env, sesion, {
          llave: "(" + activos.length + " procesos)",
          accion: "desactivar",
          despues: { procesos: activos.map((a) => a.nombre) },
        }),
      ]);
      return { success: true, desactivados: activos.length };
    }

    throw new Error("Acción de proceso no válida.");
  },
};

// Acciones del rol Planeación: los módulos que reemplazan las hojas de
// catálogo. Todas van en PERMISOS_POR_ACCION de index.js como ["planeacion"]:
// exigen esa sesión también en modo mixto.
// F2a (solo lectura): Pedidos y Clientes. Las escrituras llegan en F2b.

import { _normalizarPedido } from "./d1-negocio.js";

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
    };
  },
};

import { accionesLectura } from "./acciones-lectura.js";
import { accionesAuth } from "./acciones-auth.js";
import { accionesEscritura } from "./acciones-escritura.js";
import { accionesPlaneacion } from "./acciones-planeacion.js";
import { accionesUsuarios } from "./acciones-usuarios.js";
import { accionesProcesos } from "./acciones-procesos.js";
import * as Sentry from "@sentry/cloudflare";
import { _reconciliarSeguimientoD1 } from "./d1-negocio.js";
import {
  leerModoAuth,
  verificarSesion,
  secretoSesionesConfigurado,
} from "./sesiones.js";

// Pasan sin sesión en cualquier modo. establecerClaveUsuario la protege la
// clave maestra.
const ACCIONES_PUBLICAS = new Set([
  "nombrePorCedula",
  "validarLogin",
  "cerrarSesion",
  "establecerClaveUsuario",
]);

// Acciones que exigen sesión de ciertos roles en cualquier modo, también en
// mixto. Sin sesión → 401 sesionVencida (lleva al login); con sesión de otro
// rol → 403. Hasta el corte solo entran aquí las acciones de Planeación; en el
// corte se suman las demás y este mapa pasa a ser el mapa de permisos completo.
const PERMISOS_POR_ACCION = {
  obtenerPedidosPlaneacion: ["planeacion"],
  obtenerClientesPlaneacion: ["planeacion"],
  obtenerFormularioPedido: ["planeacion"],
  crearPedido: ["planeacion"],
  eliminarPedido: ["planeacion"],
  guardarCliente: ["planeacion"],
  obtenerPedidoParaEditar: ["planeacion"],
  editarPedido: ["planeacion"],
  obtenerEanesPedido: ["planeacion"],
  guardarEan: ["planeacion"],
  eliminarEan: ["planeacion"],
  corregirEan: ["planeacion"],
  cargarEanes: ["planeacion"],
  obtenerUsuariosPlaneacion: ["planeacion"],
  cambiarRolOperario: ["planeacion"],
  guardarRolPersona: ["planeacion"],
  guardarCuentaUsuario: ["planeacion"],
  guardarPersona: ["planeacion"],
  cambiarEstadoPersona: ["planeacion"],
  cambiarTurnoPersonas: ["planeacion"],
  guardarTurno: ["planeacion"],
  obtenerProcesosPlaneacion: ["planeacion"],
  guardarProceso: ["planeacion"],
  alinearProcesosPedidos: ["planeacion"],
};

const manejador = {
  // Cron del Worker (ver "triggers" en wrangler.jsonc). Solo corre la red de
  // seguridad de "Seguimiento paquetes"; no pasa por el token ni por ACCIONES
  // porque no lo invoca nadie desde fuera.
  async scheduled(event, env, ctx) {
    // withMonitor avisa en Sentry si el cron falla o deja de correr.
    ctx.waitUntil(
      Sentry.withMonitor(
        "reconciliacion-seguimiento",
        () =>
          _reconciliarSeguimientoD1(env).catch((err) => {
            Sentry.captureException(err, { tags: { tarea: "cron" } });
            throw err;
          }),
        {
          schedule: { type: "crontab", value: event.cron },
          checkinMargin: 5,
          maxRuntime: 10,
          timezone: "UTC",
        },
      ),
    );
  },

  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return json({
        status: "ok",
        mensaje: "API de Registro de Producción activa",
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json(
        { success: false, message: "Cuerpo de solicitud inválido" },
        400,
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(
        { success: false, message: "Cuerpo de solicitud inválido" },
        400,
      );
    }

    // `sesion` va fuera de `datos` a propósito: así no entra en la huella de
    // idempotencia de las escrituras, que se calcula sobre `datos`.
    const { action, token, datos, sesion: tokenSesion } = body;

    if (!env.TOKEN_API || token !== env.TOKEN_API) {
      return json({ success: false, message: "Token inválido" }, 401);
    }
    const handler = ACCIONES[action];
    if (!handler) {
      return json(
        { success: false, message: "Acción no reconocida: " + action },
        400,
      );
    }

    try {
      // Por el service binding CF-Connecting-IP no llega: el proxy reenvía
      // la IP real en X-Cliente-IP.
      const ip =
        request.headers.get("X-Cliente-IP") ||
        request.headers.get("CF-Connecting-IP") ||
        "desconocida";

      // Object.hasOwn: "toString" y similares no cuentan como entradas.
      const rolesPermitidos = Object.hasOwn(PERMISOS_POR_ACCION, action)
        ? PERMISOS_POR_ACCION[action]
        : null;

      let sesion = null;
      if (!ACCIONES_PUBLICAS.has(action)) {
        if (tokenSesion) {
          // Un token que no vale se rechaza también en mixto: así una cuenta
          // desactivada o una sesión vencida lleva al login desde ya.
          sesion = await verificarSesion(env, tokenSesion);
          if (!sesion) {
            if (!secretoSesionesConfigurado(env)) {
              console.error(
                "SECRET_SESIONES ausente o corto: toda sesión se ve vencida.",
              );
            }
            return json(
              {
                success: false,
                sesionVencida: true,
                message:
                  "Tu sesión venció o ya no es válida. Inicia sesión de nuevo.",
              },
              401,
            );
          }
        } else if (!rolesPermitidos && (await leerModoAuth(env)) === "mixto") {
          // Las acciones del mapa no entran  aquí: exigen sesión también en
          // mixto, y caen al 401 de abajo sin dejar log de "sin sesión".
          // Frontend viejo en caché. En S3 se revisa que ya no aparezca.
          console.log("sin sesión: " + action);
        } else {
          return json(
            {
              success: false,
              sesionVencida: true,
              message: "Inicia sesión para continuar.",
            },
            401,
          );
        }
      }

      if (rolesPermitidos && !rolesPermitidos.includes(sesion.rol)) {
        console.warn("sin permiso: " + action + " (rol " + sesion.rol + ")");
        return json(
          { success: false, message: "No tienes permiso para esta acción." },
          403,
        );
      }

      const resultado = await handler(datos || {}, env, ctx, ip, sesion);
      return json(resultado);
    } catch (err) {
      if (_esErrorInesperado(err)) {
        Sentry.captureException(err, { tags: { accion: action } });
      }
      return json({ success: false, message: err.message }, 500);
    }
  },
};

// Sentry envuelve fetch y scheduled. El DSN viene de "vars" en wrangler.jsonc.
export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: "production",
    tracesSampleRate: 0.2,
  }),
  manejador,
);

// Los mensajes de validación (new Error("Falta …")) son respuestas esperadas
// y no van a Sentry. Sí van los errores crudos de D1, los bugs (TypeError,
// ReferenceError…) y las fallas de red.
function _esErrorInesperado(err) {
  if (!(err instanceof Error)) return true;
  if (err.constructor !== Error) return true;
  return /D1_|SQLITE|network|timeout|fetch failed/i.test(err.message);
}

// Registro de todas las acciones disponibles del API, fusionando las tres
// colecciones (lectura, auth, escritura). Todas las acciones del plan original
// ya están registradas aquí.
const ACCIONES = {
  ...accionesLectura,
  ...accionesAuth,
  ...accionesEscritura,
  ...accionesPlaneacion,
  ...accionesUsuarios,
  ...accionesProcesos,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

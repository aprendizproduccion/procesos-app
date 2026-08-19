import { accionesLectura } from "./acciones-lectura.js";
import { accionesAuth } from "./acciones-auth.js";
import { accionesEscritura } from "./acciones-escritura.js";

export default {
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

    console.log("largo recibido:", token ? token.length : 0, "| largo esperado:", env.TOKEN_API.length);

    const { action, token, datos } = body;

    if (token !== env.TOKEN_API) {
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
      const resultado = await handler(datos || {}, env, ctx);
      return json(resultado);
    } catch (err) {
      return json({ success: false, message: err.message }, 500);
    }
  },
};

// Las acciones reales (getProcesos, submitRegistro, etc.) se registran aquí
// en los próximos pasos del plan. Por ahora queda vacío a propósito.
const ACCIONES = {
  ...accionesLectura,
  ...accionesAuth,
  ...accionesEscritura,
  // guardarJustificacion y submitRegistroOperario se agregan a continuación.
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

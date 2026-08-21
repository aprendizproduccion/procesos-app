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

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(
        { success: false, message: "Cuerpo de solicitud inválido" },
        400,
      );
    }

    const { action, token, datos } = body;

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
      const ip = request.headers.get("CF-Connecting-IP") || "desconocida";
      const resultado = await handler(datos || {}, env, ctx, ip);
      return json(resultado);
    } catch (err) {
      return json({ success: false, message: err.message }, 500);
    }
  },
};

// Registro de todas las acciones disponibles del API, fusionando las tres
// colecciones (lectura, auth, escritura). Todas las acciones del plan original
// ya están registradas aquí.
const ACCIONES = {
  ...accionesLectura,
  ...accionesAuth,
  ...accionesEscritura,
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

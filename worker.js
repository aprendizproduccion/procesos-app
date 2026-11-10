// worker.js — proxy que agrega el token real antes de reenviar al backend.
// El navegador nunca ve TOKEN_API: vive solo como secret de este Worker.

const BACKEND_URL = "https://registro-produccion-api.glovanze.workers.dev/";

// Sesión: el token firmado vive en esta cookie HttpOnly; el JS del navegador
// nunca lo ve. El proxy solo transporta: quien verifica es el backend.
const COOKIE_SESION = "rp_ses";

function _leerCookie(request, nombre) {
  const cabecera = request.headers.get("Cookie") || "";
  for (const parte of cabecera.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nombre) {
      return parte.slice(i + 1).trim();
    }
  }
  return "";
}

function _cookieSesion(valor, maxAgeSeg) {
  return (
    COOKIE_SESION +
    "=" +
    valor +
    "; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=" +
    maxAgeSeg
  );
}

// Solo se abre la respuesta cuando puede tocar la cookie; el resto pasa tal cual.
function _cookieDeRespuesta(accion, cuerpo) {
  let datos;
  try {
    datos = JSON.parse(cuerpo);
  } catch (e) {
    return { cuerpo, cookie: null };
  }
  if (!datos || typeof datos !== "object") return { cuerpo, cookie: null };

  if (accion === "validarLogin" && datos.success && datos.token) {
    const cookie = _cookieSesion(datos.token, Number(datos.duracion) || 0);
    delete datos.token;
    delete datos.exp;
    return { cuerpo: JSON.stringify(datos), cookie };
  }
  if (accion === "cerrarSesion" || datos.sesionVencida) {
    return { cuerpo, cookie: _cookieSesion("", 0) };
  }
  return { cuerpo, cookie: null };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" && request.method === "POST") {
      let payload;
      try {
        payload = JSON.parse(await request.text());
      } catch (e) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "Cuerpo de solicitud inválido",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      payload.token = env.TOKEN_API;
      // La sesión sale solo de la cookie: lo que mande el cuerpo se descarta.
      delete payload.sesion;
      const tokenSesion = _leerCookie(request, COOKIE_SESION);
      if (tokenSesion) payload.sesion = tokenSesion;

      try {
        const respuesta = await env.BACKEND.fetch(
          BACKEND_URL + "?cachebust=" + Date.now(),
          {
            method: "POST",
            headers: {
              "Content-Type": "text/plain;charset=utf-8",
              // Por el service binding la IP del cliente no llega sola.
              "X-Cliente-IP": request.headers.get("CF-Connecting-IP") || "",
            },
            body: JSON.stringify(payload),
          },
        );
        const { cuerpo, cookie } = _cookieDeRespuesta(
          payload.action,
          await respuesta.text(),
        );
        const cabeceras = { "Content-Type": "application/json" };
        if (cookie) cabeceras["Set-Cookie"] = cookie;
        return new Response(cuerpo, {
          status: respuesta.status,
          headers: cabeceras,
        });
      } catch (e) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "No se pudo contactar el backend",
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};

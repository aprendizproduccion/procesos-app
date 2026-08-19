// api.js — wrapper de comunicación con el backend (Registro de Producción)

var USAR_WORKER_NUEVO = true; // true = Worker + D1 | false = Apps Script (histórico). Único punto de corte.

var API_URL = USAR_WORKER_NUEVO
  ? "https://registro-produccion-api.glovanze.workers.dev/"
  : "https://script.google.com/macros/s/AKfycbwWu28Gji-rjknzhVNsdqqNHUtZiSPqFfe3TLFZo7BGVQqWDNBIt9TX0YOhfMYb_N4/exec";

var API_TOKEN = USAR_WORKER_NUEVO
  ? "9a97fcabd5b994c2cb07263ced448e2931c95f393bad9d6f" 
  : "937dc94c-cdb2-428e-8b04-b1dfb3b52280";

function llamarAPI(action, datos, intento) {
  intento = intento || 1;
  var MAX_INTENTOS = 3;
  return fetch(API_URL + "?cachebust=" + Date.now(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: action,
      token: API_TOKEN,
      datos: datos || {},
    }),
    cache: "no-store",
  })
    .then(function (res) {
      return res.text();
    })
    .then(function (texto) {
      try {
        return JSON.parse(texto);
      } catch (e) {
        console.warn(
          "llamarAPI: respuesta no-JSON en intento " +
            intento +
            " (" +
            action +
            "). Primeros 200 caracteres:",
          texto.slice(0, 200),
        );
        if (intento < MAX_INTENTOS) {
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve(llamarAPI(action, datos, intento + 1));
            }, 500 * intento);
          });
        }
        throw new Error(
          "El servidor no respondió correctamente después de varios intentos. Verifica tu conexión e inténtalo de nuevo.",
        );
      }
    });
}

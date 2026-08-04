// api.js — wrapper de comunicación con el backend Apps Script (Registro de Producción)

var API_URL = 'PEGA_AQUI_LA_URL_/exec_DE_LA_NUEVA_IMPLEMENTACION';
var API_TOKEN = 'EL_MISMO_VALOR_QUE_PUSISTE_EN_TOKEN_API_DE_CODE.GS';

function llamarAPI(action, datos) {
  return fetch(API_URL + '?cachebust=' + Date.now(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, token: API_TOKEN, datos: datos || {} }),
    cache: 'no-store'
  }).then(function(res) { return res.json(); });
}

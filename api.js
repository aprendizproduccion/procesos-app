// api.js — wrapper de comunicación con el backend Apps Script (Registro de Producción)

var API_URL = 'https://script.google.com/macros/s/AKfycbwWu28Gji-rjknzhVNsdqqNHUtZiSPqFfe3TLFZo7BGVQqWDNBIt9TX0YOhfMYb_N4/exec';
var API_TOKEN = '937dc94c-cdb2-428e-8b04-b1dfb3b52280';

function llamarAPI(action, datos) {
  return fetch(API_URL + '?cachebust=' + Date.now(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, token: API_TOKEN, datos: datos || {} }),
    cache: 'no-store'
  }).then(function(res) { return res.json(); });
}

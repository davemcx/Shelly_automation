// ============================================================
// Apertura gradual de persiana — Shelly 2PM Gen3 (mJS)
// Ventana 1 → 08:00–13:00: posición matutina → 40%
// Ventana 2 → 13:00–21:30: 40% → 75%
// Comprobación cada 15 min + al arrancar. Solo apertura (one-way).
// ============================================================

var COVER_ID          = 0;
var KVS_KEY            = "blind_morning_pos";
var CHECK_INTERVAL_MS  = 15 * 60 * 1000;
var TOLERANCE          = 1;     // margen ±1%

var W1_START = 8  * 60;
var W1_END   = 13 * 60;
var W1_TO    = 40;

var W2_START = 13 * 60;
var W2_END   = 21 * 60 + 30;
var W2_FROM  = 40;
var W2_TO    = 75;

function nowMinutes() {
  var sys = Shelly.getComponentStatus("sys");
  if (!sys || !sys.time) return -1;   // reloj aún no sincronizado
  var t = sys.time;
  var h = parseInt(t.substr(0, 2), 10);
  var m = parseInt(t.substr(3, 2), 10);
  return h * 60 + m;
}

// Interpolación lineal, resultado acotado a [v0, v1]
function lerp(t, t0, t1, v0, v1) {
  var ratio = (t - t0) / (t1 - t0);
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  return v0 + ratio * (v1 - v0);
}

function clamp(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * Obtiene la línea base matutina y el estado actual de la persiana
 * en una sola pasada, y llama a cb(morningPos, coverStatus).
 */
function resolveState(now, cb) {
  Shelly.call("Cover.GetStatus", { id: COVER_ID }, function (cov, ec, msg) {
    if (ec !== 0 || !cov || cov.current_pos === undefined || cov.current_pos === null) {
      print("Persiana: error leyendo estado (" + msg + ")");
      cb(null, null);
      return;
    }

    if (now >= W1_START && now < W1_END) {
      Shelly.call("KVS.Get", { key: KVS_KEY }, function (res, ec2) {
        if (ec2 === 0 && res && res.value !== undefined) {
          cb(parseFloat(res.value), cov);
          return;
        }
        // Aún no hay línea base guardada: se toma la posición actual
        Shelly.call("KVS.Set", { key: KVS_KEY, value: String(cov.current_pos) },
          function (res2, ec3) {
            if (ec3 !== 0) print("Persiana: error guardando línea base");
            cb(cov.current_pos, cov);
          }
        );
      });
    } else if (now >= W1_END) {
      // Fin de la ventana 1: se borra la línea base para el día siguiente
      Shelly.call("KVS.Delete", { key: KVS_KEY }, function (res, ec2) {
        if (ec2 !== 0) print("Persiana: error borrando línea base");
        cb(null, cov);
      });
    } else {
      cb(null, cov);
    }
  });
}

function applyPosition(now, morningPos, cov) {
  if (!cov) return;

  // No actuar mientras la persiana está calibrando
  if (cov.state === "calibrating") {
    print("Persiana: calibrando, se omite.");
    return;
  }

  var target = null;

  if (now >= W1_START && now < W1_END) {
    var base = (morningPos !== null && morningPos !== undefined) ? morningPos : 0;
    target = lerp(now, W1_START, W1_END, base, W1_TO);
  } else if (now >= W2_START && now < W2_END) {
    target = lerp(now, W2_START, W2_END, W2_FROM, W2_TO);
  }

  if (target === null) {
    print("Persiana: fuera de horario activo, inactiva.");
    return;
  }

  target = clamp(Math.round(target), 0, 100);

  var current = cov.current_pos;
  var delta   = target - current;

  print("Persiana: actual=" + current + "% | objetivo=" + target + "% | delta=" + delta + "%");

  if (delta <= 0) {
    print("Persiana: objetivo ≤ actual, se omite (regla one-way).");
    return;
  }

  if (Math.abs(delta) <= TOLERANCE) {
    print("Persiana: dentro de la tolerancia ±" + TOLERANCE + "%, se omite.");
    return;
  }

  print("Persiana: moviendo a " + target + "%");
  Shelly.call("Cover.SetPosition", { id: COVER_ID, pos: target });
}

function tick() {
  var now = nowMinutes();

  if (now < 0) {
    print("Persiana: reloj no sincronizado, se omite el ciclo.");
    return;
  }

  print("Persiana: ciclo a " + now + " min (" +
        Math.floor(now / 60) + ":" +
        (now % 60 < 10 ? "0" : "") + (now % 60) + ")");

  resolveState(now, function (morningPos, cov) {
    applyPosition(now, morningPos, cov);
  });
}

print("Script de persiana iniciado.");
tick();
Timer.set(CHECK_INTERVAL_MS, true, tick);

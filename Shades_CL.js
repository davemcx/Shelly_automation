// ============================================================
// SHELLY SHUTTER — CONTROLADOR DE PERSIANA ENROLLABLE
// Compatible con: Shelly 2.5 / Shelly Plus 2PM (modo Cover)
// Entorno: intérprete de scripts de Shelly (Espruino modificado
// desde firmware 1.0; versiones previas usaban mJS)
// ============================================================

// ============================================================
// CONFIGURACIÓN — edita estos valores según tu instalación
// ============================================================

var COVER_ID          = 0;       // ID del componente Cover (normalmente 0)
var CHECK_INTERVAL_MS = 900000;  // Intervalo de comprobación: 900 000 ms = 15 min

// No hace falta configurar un huso horario manual: el propio
// dispositivo calcula la hora local (con DST incluido) según la
// zona configurada en Ajustes > Ubicación de la app/web del Shelly.

// Ventana de mañana  08:01 → 13:00  (abre 5 % → 40 %)
var W1_START_H  = 8;
var W1_START_M  = 1;
var W1_END_H    = 13;
var W1_END_M    = 0;
var W1_POS_FROM = 5;
var W1_POS_TO   = 40;

// Ventana de tarde/noche  13:00 → 21:30  (abre 40 % → 75 %)
var W2_START_H  = 13;
var W2_START_M  = 0;
var W2_END_H    = 21;
var W2_END_M    = 30;
var W2_POS_FROM = 40;
var W2_POS_TO   = 75;

// Tolerancia de movimiento — no mover si el delta es <= este valor (%)
// Nota: como debe ser >= 0, esta misma comprobación ya implementa
// la regla de "solo abrir, nunca cerrar" automáticamente.
var TOLERANCE = 1;

// ============================================================
// ESTADO INTERNO — no editar
// ============================================================

var morningCleared = false;  // indica si ya se reinició el estado de la mañana hoy

// ============================================================
// FUNCIONES AUXILIARES
// ============================================================

// Hora local del dispositivo (ya ajustada a huso horario/DST).
// Devuelve null si el reloj aún no se sincronizó por NTP.
function localTime() {
  var sys = Shelly.getComponentStatus("sys");
  if (!sys || typeof sys.time !== "string") return null;
  var parts = sys.time.split(":");
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  return { h: h, m: m, totalMin: h * 60 + m };
}

function toMin(h, m) {
  return h * 60 + m;
}

// Interpolación lineal — devuelve un porcentaje entero (redondeado hacia abajo)
function linearPos(posFrom, posTo, elapsed, total) {
  if (total <= 0) return posFrom;
  return Math.floor(posFrom + (posTo - posFrom) * elapsed / total);
}

// ============================================================
// COMANDO DE MOVIMIENTO
// ============================================================

function moveTo(target) {
  print("Cover.GoToPosition -> " + target + "%");
  Shelly.call(
    "Cover.GoToPosition",
    { id: COVER_ID, pos: target },
    function (res, errCode, errMsg) {
      if (errCode !== 0) {
        print("ERROR GoToPosition: code=" + errCode + " msg=" + errMsg);
      } else {
        print("OK - la persiana se mueve a " + target + "%");
      }
    }
  );
}

// ============================================================
// COMPROBACIÓN DE SEGURIDAD Y DECISIÓN DE POSICIÓN
// ============================================================

function evaluateAndMove(target) {
  // Lectura síncrona: más simple y evita anidar callbacks
  var status = Shelly.getComponentStatus("cover", COVER_ID);
  if (!status) {
    print("ERROR: no se pudo leer el estado del Cover.");
    return;
  }

  // Errores de hardware (obstrucción, sobrecorriente, safety switch, etc.)
  var errs = status.errors;
  if (typeof errs === "object" && errs !== null && errs.length > 0) {
    print("ABORTADO POR SEGURIDAD - hay fallos activos, no se mueve.");
    for (var i = 0; i < errs.length; i++) {
      print("  fallo: " + errs[i]);
    }
    return;
  }

  var currentPos = status.current_pos;
  if (typeof currentPos !== "number") {
    print("ERROR: posición actual no disponible (¿falta calibrar?).");
    return;
  }

  var delta = target - currentPos;
  print("Actual=" + currentPos + "%  Destino=" + target + "%  Delta=" + delta + "%");

  if (delta <= TOLERANCE) {
    print("SKIP - el destino no supera la posición actual + tolerancia.");
    return;
  }

  moveTo(target);
}

// ============================================================
// BUCLE PRINCIPAL
// ============================================================

function runCheck() {
  var t = localTime();
  if (t === null) {
    print("Reloj sin sincronizar (NTP) - se reintentará en el próximo ciclo.");
    return;
  }
  var now = t.totalMin;

  var w1Start = toMin(W1_START_H, W1_START_M);
  var w1End   = toMin(W1_END_H,   W1_END_M);
  var w2Start = toMin(W2_START_H, W2_START_M);
  var w2End   = toMin(W2_END_H,   W2_END_M);

  var target  = -1;
  var elapsed = 0;
  var total   = 0;

  // ── Ventana de mañana ───────────────────────────────────
  if (now >= w1Start && now < w1End) {
    morningCleared = false;   // seguimos dentro de la ventana AM
    elapsed = now - w1Start;
    total   = w1End - w1Start;
    target  = linearPos(W1_POS_FROM, W1_POS_TO, elapsed, total);
    print("MAÑANA " + t.h + ":" + (t.m < 10 ? "0" : "") + t.m + "  destino=" + target + "%");

  // ── Ventana de tarde/noche ──────────────────────────────
  } else if (now >= w2Start && now < w2End) {
    if (!morningCleared) {
      morningCleared = true;
      print("Estado de mañana reiniciado - listo para el día siguiente.");
    }
    elapsed = now - w2Start;
    total   = w2End - w2Start;
    target  = linearPos(W2_POS_FROM, W2_POS_TO, elapsed, total);
    print("TARDE " + t.h + ":" + (t.m < 10 ? "0" : "") + t.m + "  destino=" + target + "%");

  // ── Fuera del horario activo ────────────────────────────
  } else {
    if (now >= w2End && morningCleared) {
      morningCleared = false;
      print("Fin de la ventana de tarde - estado listo para mañana.");
    }
    print("Fuera de horario (" + t.h + ":" + (t.m < 10 ? "0" : "") + t.m + "). Sin acción.");
    return;
  }

  evaluateAndMove(target);
}

// ============================================================
// PUNTO DE ENTRADA
// ============================================================

print("=== Controlador de persiana iniciado ===");
runCheck();                                     // comprobación inmediata al arrancar
Timer.set(CHECK_INTERVAL_MS, true, runCheck);   // repetir cada 15 min

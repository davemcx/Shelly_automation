// ============================================================
// SHELLY SHUTTER — CONTROLADOR DE PERSIANA ENROLLABLE (ALEATORIO)
// Compatible con: Shelly 2.5 / Shelly Plus 2PM (modo Cover)
// Entorno: intérprete de scripts de Shelly (Espruino modificado
// desde firmware 1.0; versiones previas usaban mJS)
// ============================================================
//
// A diferencia del script original (que interpolaba linealmente
// entre dos puntos), este script define 4 HORARIOS FIJOS. Cuando
// el reloj entra en una franja nueva, se elige UNA posición
// aleatoria dentro del rango de esa franja y se mantiene fija
// hasta que empiece la siguiente franja (no se recalcula en cada
// comprobación, para que la persiana no "tiemble" entre chequeos).
//
// ============================================================
// CONFIGURACIÓN — edita estos valores según tu instalación
// ============================================================

var COVER_ID          = 0;       // ID del componente Cover (normalmente 0)
var CHECK_INTERVAL_MS = 900000;  // Intervalo de comprobación: 900 000 ms = 15 min
                                  // (más corto que el original porque aquí no hay
                                  // interpolación que "suavice" el retraso: cuanto
                                  // más corto el intervalo, más cerca de la hora
                                  // exacta se disparará cada franja)

// No hace falta configurar un huso horario manual: el propio
// dispositivo calcula la hora local (con DST incluido) según la
// zona configurada en Ajustes > Ubicación de la app/web del Shelly.

// Ventana general de actividad del script: fuera de este rango
// (antes de la hora de inicio o después de la hora de fin) no se
// hace absolutamente nada, aunque el Timer siga llamando a runCheck.
var SCHEDULE_START_H = 8;
var SCHEDULE_START_M = 0;
var SCHEDULE_END_H   = 21;
var SCHEDULE_END_M   = 30;

// Franjas horarias: cada una empieza a la hora indicada y dura
// hasta que comienza la siguiente; la última dura hasta SCHEDULE_END
// (no hasta medianoche), gracias al límite general de arriba.
// posMin/posMax = rango del que se sortea la posición aleatoria (%).
var WINDOWS = [
  { startH: 8,  startM: 1, posMin: 6,  posMax: 10 },  // 08:01 -> 6-10%
  { startH: 12, startM: 0, posMin: 10, posMax: 30 },  // 12:00 -> 10-30%
  { startH: 16, startM: 0, posMin: 30, posMax: 60 },  // 16:00 -> 30-60%
  { startH: 20, startM: 0, posMin: 60, posMax: 85 }   // 20:00 -> 60-85%
];
// Nota: los rangos están definidos de forma creciente y contigua
// (6-10, 10-30, 30-60, 60-85) para que la regla "solo abrir, nunca
// cerrar" de más abajo tenga siempre sentido de una franja a la
// siguiente.

// Tolerancia de movimiento — no mover si el delta es <= este valor (%)
// Nota: como debe ser >= 0, esta misma comprobación ya implementa
// la regla de "solo abrir, nunca cerrar" automáticamente.
var TOLERANCE = 1;

// ============================================================
// ESTADO INTERNO — no editar
// ============================================================

var activeWindow = 0;    // índice (1-4) de la franja activa actualmente; 0 = ninguna
var windowTarget = -1;   // posición aleatoria ya sorteada para la franja activa

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

// Entero aleatorio uniforme en [min, max], ambos incluidos.
function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function toMin(h, m) {
  return h * 60 + m;
}

// Devuelve el índice 1-based (según WINDOWS) de la franja activa
// para el minuto del día "nowMin", o 0 si aún no ha empezado
// ninguna franja (por ejemplo, antes de las 08:01).
function findActiveWindow(nowMin) {
  var idx = 0;
  for (var i = 0; i < WINDOWS.length; i++) {
    var startMin = WINDOWS[i].startH * 60 + WINDOWS[i].startM;
    if (nowMin >= startMin) {
      idx = i + 1; // las franjas posteriores sobreescriben a las anteriores
    }
  }
  return idx;
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
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

  var scheduleStart = toMin(SCHEDULE_START_H, SCHEDULE_START_M);
  var scheduleEnd   = toMin(SCHEDULE_END_H,   SCHEDULE_END_M);

  // ── Fuera de la ventana general de actividad (antes de 08:00 o desde 21:30) ──
  if (now < scheduleStart || now >= scheduleEnd) {
    if (activeWindow !== 0) {
      print("Fin de la ventana de actividad - estado reiniciado para mañana.");
    }
    activeWindow = 0;
    windowTarget = -1;
    print("Script inactivo (" + t.h + ":" + pad(t.m) + ", fuera de 08:00-21:30). Sin acción.");
    return;
  }

  var idx = findActiveWindow(now);

  // ── Dentro de la ventana general pero antes de que empiece la 1ª franja (08:00-08:01) ──
  if (idx === 0) {
    if (activeWindow !== 0) {
      print("Fuera de todas las franjas - estado reiniciado para mañana.");
    }
    activeWindow = 0;
    windowTarget = -1;
    print("Fuera de horario (" + t.h + ":" + pad(t.m) + "). Sin acción.");
    return;
  }

  // ── Si acabamos de entrar en una franja nueva, sortear su posición ──
  if (idx !== activeWindow) {
    activeWindow = idx;
    var w = WINDOWS[idx - 1];
    windowTarget = randomInt(w.posMin, w.posMax);
    print("Nueva franja " + idx + " (desde " + w.startH + ":" + pad(w.startM) +
          ") - posición aleatoria sorteada: " + windowTarget + "% (rango " +
          w.posMin + "-" + w.posMax + "%)");
  }

  print(t.h + ":" + pad(t.m) + "  franja=" + activeWindow + "  destino=" + windowTarget + "%");
  evaluateAndMove(windowTarget);
}

// ============================================================
// PUNTO DE ENTRADA
// ============================================================

print("=== Controlador de persiana (posiciones aleatorias) iniciado ===");
runCheck();                                     // comprobación inmediata al arrancar
Timer.set(CHECK_INTERVAL_MS, true, runCheck);   // repetir cada 15 min

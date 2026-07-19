// ============================================================
// CONFIGURACIÓN
// ============================================================

var SWITCH_ID = 2;                 // Canal del switch a controlar (índice base 0)
var ON_TIME_MIN_RANGE = [7, 10];    // Duración ON en minutos [min, max]
var OFF_TIME_SEC_RANGE = [20, 30]; // Duración OFF en segundos [min, max]
var MAX_RETRIES = 5;               // Reintentos máximos ante fallo de la API
var RETRY_DELAY_MS = 10000;        // Espera entre reintentos (ms)

var cycleRunning = true;           // Bandera maestra del ciclo (false = detenido)

// ============================================================
// FUNCIONES AUXILIARES
// ============================================================

function log(msg) {
  print("[" + Date.now() + "] " + msg);
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================================
// CONTROL
// ============================================================

/**
 * Detiene el ciclo de forma segura. Llamar desde la consola: stopCycle()
 */
function stopCycle() {
  cycleRunning = false;
  log("STOP: stopCycle() invocado. Deteniendo ciclo.");

  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: false },
    function(result, err_code, err_msg) {
      if (err_code !== 0) {
        log("ADVERTENCIA: Falló el apagado de seguridad (código " + err_code + "): " + err_msg);
        log("ADVERTENCIA: ¡Verifica que el switch " + SWITCH_ID + " esté físicamente apagado!");
      } else {
        log("STOP: Apagado de seguridad confirmado. Switch " + SWITCH_ID + " está OFF.");
      }
    }
  );
}

/**
 * Wrapper de Shelly.call() con reintentos automáticos.
 * @param {string}   method     - Método RPC (ej. "Switch.Set")
 * @param {object}   params     - Parámetros del RPC
 * @param {function} onSuccess  - Callback(result) al tener éxito
 * @param {function} onFatal    - Callback() al agotar los reintentos
 * @param {number}   retryCount - Contador interno (omitir en la llamada inicial)
 */
function shellyCall(method, params, onSuccess, onFatal, retryCount) {
  if (retryCount === undefined) retryCount = 0;

  var attemptNum = retryCount + 1;
  var totalAttempts = MAX_RETRIES + 1;

  Shelly.call(method, params, function(result, err_code, err_msg) {
    if (err_code === 0) {
      if (typeof onSuccess === "function") onSuccess(result);
      return;
    }

    log(
      "ERROR: " + method + " falló (intento " + attemptNum + "/" + totalAttempts + ")" +
      " | código: " + err_code + " | msg: " + err_msg
    );

    if (retryCount < MAX_RETRIES) {
      log("REINTENTO: Esperando " + RETRY_DELAY_MS + "ms...");
      Timer.set(RETRY_DELAY_MS, false, function() {
        shellyCall(method, params, onSuccess, onFatal, retryCount + 1);
      });
      return;
    }

    log("FATAL: Se agotaron los " + MAX_RETRIES + " reintentos para [" + method + "]. Ciclo detenido.");
    cycleRunning = false;
    if (typeof onFatal === "function") onFatal();
  });
}

// ============================================================
// CICLO PRINCIPAL
// ============================================================

/**
 * Bucle recursivo: ENCENDER → esperar ON → APAGAR → esperar OFF → repetir
 */
function runCycle() {
  if (!cycleRunning) {
    log("CICLO: cycleRunning=false. runCycle() abortado.");
    return;
  }

  log("CICLO: ======= Nueva iteración ON/OFF =======");

  shellyCall(
    "Switch.Set",
    { id: SWITCH_ID, on: true },
    function() {
      var onMinutes = randomBetween(ON_TIME_MIN_RANGE[0], ON_TIME_MIN_RANGE[1]);
      var onMs = onMinutes * 60 * 1000;
      log("CICLO: Switch " + SWITCH_ID + " ON. Duración: " + onMinutes + " min (" + onMs + " ms).");

      Timer.set(onMs, false, function() {
        if (!cycleRunning) {
          log("CICLO: Detenido durante fase ON. No se pasa a OFF.");
          return;
        }

        log("CICLO: Fase ON completa. Apagando...");

        shellyCall(
          "Switch.Set",
          { id: SWITCH_ID, on: false },
          function() {
            var offSeconds = randomBetween(OFF_TIME_SEC_RANGE[0], OFF_TIME_SEC_RANGE[1]);
            var offMs = offSeconds * 1000;
            log("CICLO: Switch " + SWITCH_ID + " OFF. Duración: " + offSeconds + " seg (" + offMs + " ms).");

            Timer.set(offMs, false, function() {
              if (!cycleRunning) {
                log("CICLO: Detenido durante fase OFF. No se reinicia.");
                return;
              }
              log("CICLO: Fase OFF completa. Reiniciando ciclo...");
              runCycle();
            });
          },
          function() {
            log("FATAL: No se pudo apagar el switch " + SWITCH_ID + " tras la fase ON. ¡Requiere intervención manual!");
          }
        );
      });
    },
    function() {
      log("FATAL: No se pudo encender el switch " + SWITCH_ID + ". Ciclo detenido.");
    }
  );
}

// ============================================================
// INICIALIZACIÓN
// ============================================================

log("=== Iniciando script de ciclo aleatorio v1.1 ===");
log(
  "CONFIG: SwitchID=" + SWITCH_ID +
  " | ON=" + ON_TIME_MIN_RANGE[0] + "-" + ON_TIME_MIN_RANGE[1] + " min" +
  " | OFF=" + OFF_TIME_SEC_RANGE[0] + "-" + OFF_TIME_SEC_RANGE[1] + " seg" +
  " | MaxReintentos=" + MAX_RETRIES +
  " | EsperaReintento=" + RETRY_DELAY_MS + "ms"
);
log("INFO: Llama a stopCycle() desde la consola para detener el ciclo en cualquier momento.");

runCycle();

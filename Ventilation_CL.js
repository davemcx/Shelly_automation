// ================================================================
//  Controlador de Ciclo de Trabajo Dinámico
//  - El tiempo ON disminuye linealmente cada ciclo
//  - El tiempo OFF aumenta linealmente cada ciclo
//  - Incluye seguridad, reintentos y parada segura
// ================================================================

// ---------------------------------------------------------------
// 1. CONFIGURACIÓN
// ---------------------------------------------------------------
var SWITCH_ID       = 0;    // Canal del relé a controlar
var INITIAL_ON_MIN  = 30;   // Duración ON inicial (minutos)
var INITIAL_OFF_MIN = 1;    // Duración OFF inicial (minutos)
var STEP_MIN        = 1;    // Paso lineal por ciclo (minutos)
var MAX_RETRIES     = 2;    // Reintentos RPC antes de abortar
var MAX_RUNTIME_MIN = 540;  // Techo de seguridad (9 horas)

// ---------------------------------------------------------------
// VARIABLES DE ESTADO
// ---------------------------------------------------------------
var onMin           = INITIAL_ON_MIN;
var offMin          = INITIAL_OFF_MIN;
var cycleCount      = 0;
var currentTimer    = null;
var maxRuntimeTimer = null;
var isRunning       = false;
var isTerminating   = false;

// ================================================================
// 2. UTILIDAD DE LOG
// ================================================================
function log(level, msg) {
  print("[" + level + "] DutyCycle: " + msg);
}

// ================================================================
// 3. TERMINACIÓN SEGURA
// ================================================================
function terminateScript(reason) {
  if (isTerminating) {
    log("WARN", "terminateScript ya en curso, ignorando reentrada.");
    return;
  }
  isTerminating = true;

  log("INFO", "--- Terminando --- Motivo: " + reason);

  if (currentTimer !== null) {
    Timer.clear(currentTimer);
    currentTimer = null;
    log("INFO", "Timer de ciclo cancelado.");
  }

  if (maxRuntimeTimer !== null) {
    Timer.clear(maxRuntimeTimer);
    maxRuntimeTimer = null;
    log("INFO", "Timer de seguridad cancelado.");
  }

  // Medida final: garantizar que el switch quede en OFF
  log("INFO", "Enviando apagado final antes de salir...");
  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: false },
    function(res, err_code, err_msg) {
      if (err_code !== 0) {
        log("WARN", "Apagado final falló (code=" + err_code + "): " + err_msg);
      } else {
        log("INFO", "Switch confirmado OFF. Seguro para salir.");
      }
      die(); // Detiene el motor del script
    }
  );
}

// ================================================================
// 4. WRAPPER DE REINTENTOS RPC
// ================================================================
//  Intenta Switch.Set hasta (1 + MAX_RETRIES) veces en total,
//  con 500 ms de espera entre cada reintento.
// ================================================================
function callWithRetry(state, retriesLeft, onSuccess, onFailure) {
  if (isTerminating) return;

  var label = state ? "ON" : "OFF";

  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: state },
    function(res, err_code, err_msg) {

      if (err_code === 0) {
        log("INFO", "Switch.Set -> " + label + " exitoso.");
        onSuccess();
        return;
      }

      log("WARN",
        "Switch.Set -> " + label + " falló " +
        "(code=" + err_code + ", msg=" + err_msg + "). " +
        "Reintentos restantes: " + retriesLeft
      );

      if (retriesLeft > 0) {
        Timer.set(500, false, function() {
          callWithRetry(state, retriesLeft - 1, onSuccess, onFailure);
        });
      } else {
        log("ERROR", "Switch.Set -> " + label + " agotó todos los reintentos.");
        onFailure();
      }
    }
  );
}

// ================================================================
// 5. LÓGICA PRINCIPAL DEL CICLO
// ================================================================
//  Secuencia por ciclo:
//    [Calcular tiempos]
//    -> Switch ON  -> esperar onMin  minutos
//    -> Switch OFF -> esperar offMin minutos
//    -> cycleCount++ -> runCycle() (siguiente iteración)
// ================================================================
function runCycle() {
  if (isTerminating) return;

  if (isRunning) {
    log("WARN", "runCycle invocado mientras ya corría — se omite llamada duplicada.");
    return;
  }

  // --- Recalcular tiempos para esta iteración ---
  onMin  = INITIAL_ON_MIN  - (cycleCount * STEP_MIN);
  offMin = INITIAL_OFF_MIN + (cycleCount * STEP_MIN);

  log("INFO",
    "=== Ciclo " + cycleCount +
    " | ON=" + onMin + " min" +
    " | OFF=" + offMin + " min ==="
  );

  // --- Condiciones de parada ---
  if (onMin <= 0) {
    terminateScript("onMin llegó a " + onMin + " (<= 0) en el ciclo " + cycleCount);
    return;
  }
  if (offMin > INITIAL_ON_MIN) {
    terminateScript(
      "offMin (" + offMin + ") superó INITIAL_ON_MIN (" +
      INITIAL_ON_MIN + ") en el ciclo " + cycleCount
    );
    return;
  }

  isRunning = true;

  // ---- PASO 1: Encender switch ----
  callWithRetry(
    true,
    MAX_RETRIES,
    function() {
      if (isTerminating) return;

      log("INFO", "Fase ON iniciada. Duración: " + onMin + " min.");

      currentTimer = Timer.set(
        onMin * 60 * 1000,
        false,
        function() {
          currentTimer = null;
          if (isTerminating) return;

          // ---- PASO 2: Apagar switch ----
          callWithRetry(
            false,
            MAX_RETRIES,
            function() {
              if (isTerminating) return;

              log("INFO", "Fase OFF iniciada. Duración: " + offMin + " min.");

              currentTimer = Timer.set(
                offMin * 60 * 1000,
                false,
                function() {
                  currentTimer = null;
                  if (isTerminating) return;

                  // ---- PASO 3: Avanzar y recursar ----
                  log("INFO", "Ciclo " + cycleCount + " completado.");
                  cycleCount++;
                  isRunning = false;
                  runCycle();
                }
              );
            },
            function() {
              terminateScript("RPC Switch OFF falló tras todos los reintentos en el ciclo " + cycleCount);
            }
          );
        }
      );
    },
    function() {
      terminateScript("RPC Switch ON falló tras todos los reintentos en el ciclo " + cycleCount);
    }
  );
}

// ================================================================
// 6. MANEJADOR DE EVENTO DE PARADA EXTERNA
// ================================================================
//  Captura eventos de "script detenido" a nivel de dispositivo para
//  que ningún timer pendiente dispare después de una parada externa
//  (ej. desde la app o vía RPC).
// ================================================================
Shelly.addEventHandler(function(event) {
  if (!event) return;

  var isScriptEvent = (
    typeof event.component === "string" &&
    event.component.indexOf("script") === 0
  );

  if (isScriptEvent && event.event === "stopped") {
    log("INFO", "Evento externo 'stopped' recibido. Cancelando todos los timers.");

    if (currentTimer !== null) {
      Timer.clear(currentTimer);
      currentTimer = null;
    }
    if (maxRuntimeTimer !== null) {
      Timer.clear(maxRuntimeTimer);
      maxRuntimeTimer = null;
    }
  }
});

// ================================================================
// 7. INICIALIZACIÓN
// ================================================================
log("INFO", "Iniciando Controlador de Ciclo de Trabajo Dinámico...");
log("INFO",
  "Config -> " +
  "SWITCH_ID="       + SWITCH_ID       + " | " +
  "INITIAL_ON="      + INITIAL_ON_MIN  + " min | " +
  "INITIAL_OFF="     + INITIAL_OFF_MIN + " min | " +
  "STEP="            + STEP_MIN        + " min | " +
  "MAX_RETRIES="     + MAX_RETRIES     + " | " +
  "MAX_RUNTIME="     + MAX_RUNTIME_MIN + " min"
);

// Verificar que el relé responda antes de hacer nada
Shelly.call(
  "Switch.GetStatus",
  { id: SWITCH_ID },
  function(res, err_code, err_msg) {

    if (err_code !== 0) {
      log("ERROR",
        "Switch.GetStatus falló (code=" + err_code + "): " + err_msg +
        ". No se puede continuar — abortando."
      );
      die();
      return;
    }

    log("INFO",
      "Switch " + SWITCH_ID + " responde correctamente. " +
      "Estado actual: " + (res.output ? "ON" : "OFF")
    );

    // --- Iniciar el timer de seguridad global (watchdog) ---
    maxRuntimeTimer = Timer.set(
      MAX_RUNTIME_MIN * 60 * 1000,
      false,
      function() {
        maxRuntimeTimer = null;
        terminateScript("Se alcanzó el techo MAX_RUNTIME_MIN (" + MAX_RUNTIME_MIN + " min)");
      }
    );

    log("INFO", "Watchdog de seguridad armado por " + MAX_RUNTIME_MIN + " min.");

    // --- Iniciar el primer ciclo de trabajo ---
    runCycle();
  }
);

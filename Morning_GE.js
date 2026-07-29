// =============================================================================
// Shelly 1 Mini Gen4 - Secuencia de Relé Programada
// =============================================================================

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────

var RELAY_ID        = 0;     // Shelly 1 Mini Gen4 tiene un relé (ID 0)
var OFF_PAUSE_MS    = 500;   // Pausa de medio segundo entre encendidos (ms)

// Cambia esto a 'false' tras la primera ejecución exitosa para evitar duplicar horarios.
// Los horarios se guardan en el dispositivo y sobreviven a los reinicios.
var CREATE_SCHEDULES = true;

// Expresiones CRON (formato Shelly: seg min hora dia_mes mes dia_sem)
var CRON_WEEKDAYS = "0 35 5 * * 1,2,3,4,5"; // Lunes a Viernes a las 05:35
var CRON_WEEKENDS = "0 30 8 * * 6,0";       // Sábados y Domingos a las 08:30 (0 = Domingo)

// Secuencia: tiempos de encendido en milisegundos
var SEQUENCE = [1000, 2000, 4000, 8000, 16000, 32000, 60000];


// ── ESTADO ────────────────────────────────────────────────────────────────────

var sequenceRunning = false;
var activeTimer     = null;


// ── CONTROL DE RELÉ ───────────────────────────────────────────────────────────

function setRelay(on) {
  Shelly.call(
    "Switch.Set",
    { id: RELAY_ID, on: on },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        print("ERROR Switch.Set →", error_code, error_message);
      }
    }
  );
}


// ── MOTOR DE LA SECUENCIA ─────────────────────────────────────────────────────

function runStep(stepIndex) {
  // ── Fin de la secuencia: dejar encendido indefinidamente ────────────────
  if (stepIndex >= SEQUENCE.length) {
    print("--- Secuencia completada: relé ENCENDIDO permanentemente ---");
    setRelay(true);
    sequenceRunning = false;
    activeTimer     = null;
    return;
  }

  var onDuration = SEQUENCE[stepIndex];
  var stepNum    = stepIndex + 1;
  var totalSteps = SEQUENCE.length;

  print("Paso " + stepNum + "/" + totalSteps + " → ON por " + (onDuration / 1000) + "s");
  
  // 1. Encender el relé
  setRelay(true);

  // 2. Programar apagado según el tiempo del paso actual
  activeTimer = Timer.set(onDuration, false, function() {

    print("Paso " + stepNum + "/" + totalSteps + " → OFF por " + OFF_PAUSE_MS + "ms");
    setRelay(false);

    // 3. Programar el siguiente paso tras la pausa de medio segundo
    activeTimer = Timer.set(OFF_PAUSE_MS, false, function() {
      runStep(stepIndex + 1);
    });

  });
}

// Función principal llamada por los horarios
function startSequence() {
  if (sequenceRunning) {
    print("ADVERTENCIA: La secuencia ya está en curso — ignorando ejecución duplicada.");
    return;
  }

  // Limpiar temporizadores huérfanos por seguridad
  if (activeTimer !== null) {
    Timer.clear(activeTimer);
    activeTimer = null;
  }

  sequenceRunning = true;
  print("=== Inicio de secuencia del relé ===");
  runStep(0);
}


// ── CREACIÓN AUTOMÁTICA DE HORARIOS ───────────────────────────────────────────

function scheduleExists(jobs, cron) {
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].timespec === cron) {
      return true;
    }
  }
  return false;
}

function createSchedule(cron, label, scriptId) {
  Shelly.call(
    "Schedule.Create",
    {
      enable   : true,
      timespec : cron,
      calls    : [
        {
          method : "Script.Eval",
          params : {
            id   : scriptId,
            code : "startSequence();"
          }
        }
      ]
    },
    function(result, error_code, error_message) {
      if (error_code === 0) {
        print("Horario creado exitosamente → " + label + " [ID: " + result.id + "]");
      } else {
        print("ERROR al crear horario '" + label + "' →", error_code, error_message);
      }
    }
  );
}

function initSchedules() {
  var scriptId = Shelly.getCurrentScriptId();

  Shelly.call(
    "Schedule.List",
    {},
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        print("ERROR listando horarios →", error_code, error_message);
        return;
      }

      var jobs = result.jobs || [];

      // Horario de Lunes a Viernes
      if (!scheduleExists(jobs, CRON_WEEKDAYS)) {
        createSchedule(CRON_WEEKDAYS, "Lunes a Viernes 05:35", scriptId);
      } else {
        print("El horario ya existe → Lunes a Viernes 05:35");
      }

      // Horario de Fines de Semana
      if (!scheduleExists(jobs, CRON_WEEKENDS)) {
        createSchedule(CRON_WEEKENDS, "Fines de semana 08:30", scriptId);
      } else {
        print("El horario ya existe → Fines de semana 08:30");
      }
    }
  );
}


// ── INICIO DEL SCRIPT ─────────────────────────────────────────────────────────

print("Script cargado. Motor de secuencia listo.");
print("Relé ID:", RELAY_ID, "| Total de pasos:", SEQUENCE.length);

if (CREATE_SCHEDULES) {
  initSchedules();
} else {
  print("Creación automática de horarios desactivada.");
}

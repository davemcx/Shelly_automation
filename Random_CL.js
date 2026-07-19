// --- Configuración y estado ---
var BASE_INTERVALS = [2, 4, 6, 8, 9, 11, 13, 15];
var WIN_START = 21; // 21:00 (9 PM)
var WIN_END = 23;   // 23:00 (11 PM, exclusivo)
var SWITCH_ID = 0;

var shuffledIntervals = [];
var currentIntervalIndex = -1;
var isCycleActive = false;
var cycleCompleteToday = false;
var activeTimerId = null;

// --- Funciones auxiliares ---

// Fisher-Yates manual, compatible con mJS (sin métodos avanzados de array)
function shuffleIntervalsArray() {
  shuffledIntervals = [];
  for (var i = 0; i < BASE_INTERVALS.length; i++) {
    shuffledIntervals.push(BASE_INTERVALS[i]);
  }

  for (var j = shuffledIntervals.length - 1; j > 0; j--) {
    var randIndex = Math.floor(Math.random() * (j + 1));
    var temp = shuffledIntervals[j];
    shuffledIntervals[j] = shuffledIntervals[randIndex];
    shuffledIntervals[randIndex] = temp;
  }
  print("Intervalos mezclados para esta noche: ", JSON.stringify(shuffledIntervals));
}

// Enciende/apaga el relé con manejo de error RPC
function setRelayState(isOn) {
  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: isOn },
    function (result, error_code, error_msg) {
      if (error_code !== 0) {
        print("Error RPC (" + error_code + "): " + error_msg);
      }
    }
  );
}

function clearActiveTimer() {
  if (activeTimerId !== null) {
    Timer.clear(activeTimerId);
    activeTimerId = null;
  }
}

// Extrae la hora local actual desde el estado del sistema
function getCurrentHour() {
  var sysStatus = Shelly.getComponentStatus("sys");
  if (sysStatus && sysStatus.time) {
    // Formato esperado "HH:MM"
    var timeParts = sysStatus.time.split(":");
    if (timeParts.length >= 1) {
      return JSON.parse(timeParts[0]);
    }
  }
  return -1; // Estado de fallo
}

// --- Flujo de ejecución del ciclo ---

function runNextPhase() {
  var currentHour = getCurrentHour();

  // Si ya salimos de la ventana horaria, abortar
  if (currentHour < WIN_START || currentHour >= WIN_END) {
    print("Se salió de la ventana horaria durante la ejecución. Abortando ciclo.");
    abortCycle();
    return;
  }

  currentIntervalIndex++;

  if (currentIntervalIndex >= shuffledIntervals.length) {
    print("Todos los intervalos agotados. Ciclo nocturno completo.");
    setRelayState(false);
    isCycleActive = false;
    cycleCompleteToday = true;
    return;
  }

  // Fase 1: Encender relé
  var onMinutes = shuffledIntervals[currentIntervalIndex];
  print("Iniciando Fase 1 (ON): Elemento " + currentIntervalIndex + " por " + onMinutes + " minutos.");
  setRelayState(true);

  clearActiveTimer();
  activeTimerId = Timer.set(onMinutes * 60 * 1000, false, function () {
    // Fase 2: Apagar relé (pausa de buffer aleatoria)
    var currentHourCheck = getCurrentHour();
    if (currentHourCheck < WIN_START || currentHourCheck >= WIN_END) {
      abortCycle();
      return;
    }

    // 50% de probabilidad entre 2 o 3 minutos
    var offMinutes = Math.random() < 0.5 ? 2 : 3;
    print("Iniciando Fase 2 (buffer OFF): Pausando por " + offMinutes + " minutos.");
    setRelayState(false);

    clearActiveTimer();
    activeTimerId = Timer.set(offMinutes * 60 * 1000, false, function () {
      runNextPhase(); // Siguiente intervalo ON
    });
  });
}

function abortCycle() {
  clearActiveTimer();
  setRelayState(false);
  isCycleActive = false;
}

// --- Watchdog ---

function watchdogTick() {
  var hour = getCurrentHour();
  if (hour === -1) {
    print("Advertencia: No se pudo obtener la hora del sistema.");
    return;
  }

  if (hour >= WIN_START && hour < WIN_END) {
    if (!isCycleActive && !cycleCompleteToday) {
      print("Entrando a la ventana horaria. Inicializando ciclo nocturno.");
      shuffleIntervalsArray();
      currentIntervalIndex = -1;
      isCycleActive = true;
      runNextPhase();
    }
  } else {
    // Fuera de la ventana: reiniciar banderas para el día siguiente
    if (cycleCompleteToday || isCycleActive) {
      print("Fuera de la ventana horaria. Reiniciando banderas diarias.");
      abortCycle();
      cycleCompleteToday = false;
    }
  }
}

// --- Inicialización ---

print("Script de Ciclo Aleatorio Shelly iniciado.");
watchdogTick(); // Verificación inmediata al arrancar
Timer.set(60 * 1000, true, watchdogTick); // Watchdog cada 60 segundos

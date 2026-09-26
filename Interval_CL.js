// Sequential ON/OFF routine for Shelly Plus Plug S
var sequence = [
  { state: true,  duration: 15 },
  { state: false, duration: 10 },
  { state: true,  duration: 1  },
  { state: false, duration: 10 },
  { state: true,  duration: 15 },
  { state: false, duration: 10 },
  { state: true,  duration: 1  },
  { state: false, duration: 10 },
  { state: true,  duration: 10 }
];

var currentStep = 0;
var timer = null;
var stopping = false; // Flag local, evita race condition con KVS

function minutesToMs(m) { return m * 60 * 1000; }

function totalDuration() {
  var t = 0;
  for (var i = 0; i < sequence.length; i++) t += sequence[i].duration;
  return t;
}

function stopSequence(reason) {
  if (stopping) return; // Evita llamadas duplicadas
  stopping = true;

  if (timer !== null) {
    Timer.clear(timer);
    timer = null;
  }

  print("Stopping:", reason);

  Shelly.call("Switch.Set", { id: 0, on: false }, function(res, code, msg) {
    if (code !== 0) print("Error turning off:", msg);
    else print("Switch OFF.");

    Shelly.call("KVS.Delete", { key: "stop_sequence" }, null);
    // No llamar Script.Stop desde adentro — simplemente no se agenda más nada
    print("Sequence ended. No more steps will run.");
  });
}

function executeStep() {
  if (stopping) return;

  // Verificar stop flag ANTES de actuar, con callback que controla el flujo
  Shelly.call("KVS.Get", { key: "stop_sequence" }, function(result) {
    if (stopping) return;

    if (result && result.value === "true") {
      stopSequence("external stop flag");
      return;
    }

    if (currentStep >= sequence.length) {
      stopSequence("sequence complete");
      return;
    }

    var step = sequence[currentStep];
    print("Step " + (currentStep + 1) + "/" + sequence.length +
          ": " + (step.state ? "ON" : "OFF") + " for " + step.duration + " min");

    Shelly.call("Switch.Set", { id: 0, on: step.state }, function(res, code, msg) {
      if (stopping) return;

      if (code !== 0) {
        stopSequence("switch error: " + msg);
        return;
      }

      currentStep++;
      timer = Timer.set(minutesToMs(step.duration), false, executeStep);
      // Pasar la función directamente evita crear un closure innecesario
    });
  });
}

print("Starting sequence — total: " + totalDuration() + " min");
print("To stop: Shelly.call('KVS.Set', {key:'stop_sequence', value:'true'})");
executeStep();

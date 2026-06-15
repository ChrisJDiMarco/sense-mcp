import type { Sensor } from "../types.js";
import { activeWindowSensor } from "./activeWindow.js";
import { ambientLightSensor } from "./ambientLight.js";
import { audioLevelSensor } from "./audioLevel.js";
import { batterySensor } from "./battery.js";
import { calendarSensor } from "./calendar.js";
import { cameraSensor } from "./camera.js";
import { devicesSensor } from "./devices.js";
import { focusModeSensor } from "./focusMode.js";
import { healthBridgeSensor, weatherBridgeSensor } from "./semanticBridge.js";
import { idleSensor } from "./idle.js";
import { locationSensor } from "./location.js";
import { mediaSensor } from "./media.js";
import { timeContextSensor } from "./timeContext.js";
import { workspaceSensor } from "./workspace.js";
import { mockSensor } from "./mock.js";

/** Register new sensors here — that's the whole contribution surface. */
export const sensors: Sensor[] = [
  activeWindowSensor,
  idleSensor,
  timeContextSensor,
  batterySensor,
  devicesSensor,
  workspaceSensor,
  calendarSensor,
  locationSensor,
  mediaSensor,
  ambientLightSensor,
  audioLevelSensor,
  focusModeSensor,
  cameraSensor,
  healthBridgeSensor,
  weatherBridgeSensor,
  mockSensor,
];

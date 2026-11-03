import { feetToMetres, highWater } from "@tidepool/core";

/** Turn raw gauge readings (in feet) into the table the /v2/tides endpoint returns. */
export function tideTable(station, readings) {
  const rows = readings.map((reading) => ({ at: reading.at, metres: feetToMetres(reading.feet) }));
  return { station, rows, highWater: highWater(rows) };
}

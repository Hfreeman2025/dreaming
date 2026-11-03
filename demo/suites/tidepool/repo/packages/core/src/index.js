/** Heights are stored in metres above chart datum. */
export const DATUM = "chart datum";

export function feetToMetres(feet) {
  return Math.round(feet * 0.3048 * 100) / 100;
}

/** The highest reading in a list of { at, metres } readings. */
export function highWater(readings) {
  return readings.reduce((best, reading) => (reading.metres > best.metres ? reading : best));
}

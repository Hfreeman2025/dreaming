/** Scale a tide table to chart coordinates for the dashboard. */
export function toPoints(table, height) {
  const top = table.highWater.metres;
  return table.rows.map((row, i) => ({ x: i, y: height - (row.metres / top) * height }));
}

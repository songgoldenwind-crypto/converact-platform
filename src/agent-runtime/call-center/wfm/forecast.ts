export interface HistoricalVolume {
  date: string;
  hour: number;
  volume: number;
}

export interface ForecastResult {
  date: string;
  hour: number;
  predicted_volume: number;
}

export function forecastVolume(
  historicalData: HistoricalVolume[],
  targetDate: string,
  opts?: { alpha?: number }
): ForecastResult[] {
  const alpha = opts?.alpha ?? 0.3;
  const byHour = new Map<number, number[]>();

  for (const entry of historicalData) {
    const existing = byHour.get(entry.hour) ?? [];
    existing.push(entry.volume);
    byHour.set(entry.hour, existing);
  }

  const results: ForecastResult[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const values = byHour.get(hour) ?? [];
    results.push({
      date: targetDate,
      hour,
      predicted_volume: simpleExponentialSmoothing(values, alpha)
    });
  }
  return results;
}

function simpleExponentialSmoothing(values: number[], alpha: number): number {
  if (values.length === 0) return 0;
  let forecast = values[0];
  for (let i = 1; i < values.length; i++) {
    forecast = alpha * values[i] + (1 - alpha) * forecast;
  }
  return Math.round(forecast * 10) / 10;
}

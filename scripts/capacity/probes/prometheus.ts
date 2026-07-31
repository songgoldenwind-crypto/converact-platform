export interface PrometheusSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/;

export function parsePrometheusText(text: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = SAMPLE.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels = parseLabels(match[2] || '');
    if (labels === null) continue;
    samples.push({
      metric: match[1],
      labels,
      value
    });
  }
  return samples;
}

export function aggregatePrometheusMetric(input: {
  samples: PrometheusSample[];
  metric: string;
  aggregation: 'sum' | 'max' | 'min';
  labels?: Record<string, string>;
}): number | null {
  const values = input.samples
    .filter((sample) => sample.metric === input.metric && labelsMatch(sample.labels, input.labels))
    .map((sample) => sample.value);
  if (values.length === 0) return null;
  switch (input.aggregation) {
    case 'sum': return values.reduce((sum, value) => sum + value, 0);
    case 'max': return Math.max(...values);
    case 'min': return Math.min(...values);
  }
}

function parseLabels(input: string): Record<string, string> | null {
  if (!input) return {};
  const labels: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/g;
  let consumed = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index !== consumed) return null;
    labels[match[1]] = unescapeLabel(match[2]);
    consumed = match.index + match[0].length;
  }
  return consumed === input.length ? labels : null;
}

function unescapeLabel(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function labelsMatch(
  sample: Record<string, string>,
  expected: Record<string, string> | undefined
): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => sample[key] === value);
}

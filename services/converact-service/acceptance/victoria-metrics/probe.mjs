const [operation, endpoint] = process.argv.slice(2);

if (operation === 'source') {
  const response = await fetch(`${endpoint}/value`);
  if (!response.ok) throw new Error(`source returned ${response.status}`);
  const body = await response.json();
  const value = Number(body.value);
  if (!Number.isFinite(value)) throw new Error('source value is invalid');
  process.stdout.write(`${Math.floor(value)}\n`);
} else if (operation === 'query') {
  const url = new URL('/api/v1/query', endpoint);
  url.searchParams.set('query', 'converact_vm_acceptance_counter');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`query returned ${response.status}`);
  const body = await response.json();
  const value = Number(body?.data?.result?.[0]?.value?.[1]);
  if (body.status !== 'success' || !Number.isFinite(value)) {
    throw new Error('acceptance metric is not queryable');
  }
  process.stdout.write(`${Math.floor(value)}\n`);
} else {
  throw new Error('operation must be source or query');
}

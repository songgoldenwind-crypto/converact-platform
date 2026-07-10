export function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

export function notFound(message: string) {
  return Object.assign(new Error(message), { status: 404 });
}

export function required(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') {
    throw badRequest(`${field} is required`);
  }
  return value;
}

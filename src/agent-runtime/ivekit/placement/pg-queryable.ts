export interface PlacementPgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{
    rows: R[];
    rowCount?: number | null;
  }>;
}

type Row = Record<string, unknown>;

/** Read all rows in stable pages; never calculate totals from a truncated response. */
export async function readCostRows(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const all: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    const page = Array.isArray(data) ? data as Row[] : [];
    all.push(...page);
    if (page.length < 1000) return all;
  }
}


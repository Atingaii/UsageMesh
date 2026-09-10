const collator = new Intl.Collator("zh-CN", { numeric: true });
const idCollator = new Intl.Collator();

// Evaluate display/sort keys once per row, not once for every comparison.
export function sortTableRows<Row extends { id: string }>(
  rows: Row[],
  value: (row: Row) => string | number,
  ascending: boolean,
): Row[] {
  return rows
    .map((row) => ({ row, key: value(row) }))
    .sort((a, b) => {
      const compare =
        typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : collator.compare(String(a.key), String(b.key));
      return (
        (ascending ? compare : -compare) ||
        idCollator.compare(a.row.id, b.row.id)
      );
    })
    .map(({ row }) => row);
}

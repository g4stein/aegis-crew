import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: string;
  align?: 'start' | 'end';
  render: (row: Row) => ReactNode;
  /** Marks the cell as a critical alert (acid) or contained (inverted). */
  tone?: (row: Row) => 'critical' | 'contained' | undefined;
}

/** Ruled data table. Hover inverts the row. */
export function LedgerTable<Row>({ caption, columns, rows, rowKey }: { caption: string; columns: readonly Column<Row>[]; rows: readonly Row[]; rowKey: (row: Row) => string }) {
  return (
    <div className="table-scroll">
      <table className="ledger">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" data-align={c.align ?? 'start'}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => {
                const tone = c.tone?.(row);
                return (
                  <td
                    key={c.key}
                    data-align={c.align ?? 'start'}
                    data-critical={tone === 'critical' || undefined}
                    data-contained={tone === 'contained' || undefined}
                  >
                    {c.render(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

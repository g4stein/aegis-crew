import { formatAmount, formatDelta } from '../../core/format';
import type { ContractSnapshot, InvariantReading } from '../../core/model';
import { Glyph, Mark } from '../primitives/Glyph';
import { LedgerTable, type Column } from '../primitives/LedgerTable';
import { Cell } from '../primitives/Sheet';
import { SectionHead } from '../primitives/Type';

interface Row {
  contract: ContractSnapshot;
  inv: InvariantReading;
}

const COLUMNS: readonly Column<Row>[] = [
  {
    key: 'inv',
    header: 'Invariant',
    render: ({ contract, inv }) => (
      <>
        <div>{inv.label}</div>
        <div className="label">{contract.contractId} / {inv.id}</div>
      </>
    ),
  },
  { key: 'req', header: 'Req', render: ({ inv }) => inv.requirement },
  { key: 'expected', header: 'Expected', align: 'end', render: ({ inv }) => formatAmount(inv.expected) },
  { key: 'observed', header: 'Observed', align: 'end', render: ({ inv }) => formatAmount(inv.observed) },
  { key: 'delta', header: '\u0394', align: 'end', render: ({ inv }) => formatDelta(inv.observed, inv.expected) },
  {
    key: 'status',
    header: 'Status',
    render: ({ contract, inv }) => (
      <Glyph kind={inv.status === 'holding' ? 'holding' : contract.paused ? 'contained' : 'breach'} />
    ),
    tone: ({ contract, inv }) => {
      if (inv.status === 'holding') return undefined;
      return contract.paused ? 'contained' : 'critical';
    },
  },
];

export function InvariantLedger({ contracts }: { contracts: readonly ContractSnapshot[] }) {
  const rows: Row[] = contracts.flatMap((contract) => contract.invariants.map((inv) => ({ contract, inv })));
  return (
    <Cell span={7} pad="none" labelledBy="ledger-title">
      <SectionHead id="ledger-title" title="Invariant ledger" meta="Req 1" />
      <LedgerTable caption="Invariant ledger" columns={COLUMNS} rows={rows} rowKey={(r) => `${r.contract.contractId}/${r.inv.id}`} />
      <dl className="definition">
        <div>
          <dt className="label">Definition</dt>
          <dd className="data-lg">Σ balanceOf(a) = totalSupply, and balanceOf(a) &gt;= 0 for every a</dd>
        </div>
        <div>
          <dt className="label">Evaluated</dt>
          <dd>Each block, against state read at one pinned block height</dd>
        </div>
        <div>
          <dt className="label">On breach</dt>
          <dd>
            Pause intent <Mark shape="arrow-right" /> allowlist and selector gate <Mark shape="arrow-right" /> aegis-guard.request_pause{' '}
            <Mark shape="arrow-right" /> MPC sign
          </dd>
        </div>
      </dl>
    </Cell>
  );
}

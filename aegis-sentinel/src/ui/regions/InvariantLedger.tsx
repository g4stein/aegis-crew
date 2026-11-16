import { formatAmount, formatDelta, shortHex } from '../../core/format';
import type { ContractSnapshot, FeedSource, InvariantReading } from '../../core/model';
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

function Provenance({ source }: { source: FeedSource | undefined }) {
  if (source?.kind !== 'live-mock') return <dd>Scripted demo values. Switch to live-mock to load the Forge output.</dd>;
  if (!source.invariantsFile) return <dd>Waiting for the runtime</dd>;
  return (
    <dd className="mono-wrap">
      {source.invariantsFile}
      <div className="label">
        file sha256 {shortHex(`0x${source.invariantsSha256 ?? ''}`, 14, 6).slice(2)} · solidity sha256 {shortHex(`0x${source.sourceSha256 ?? ''}`, 14, 6).slice(2)}
      </div>
    </dd>
  );
}

export function InvariantLedger({ contracts, source }: { contracts: readonly ContractSnapshot[]; source?: FeedSource }) {
  const rows: Row[] = contracts.flatMap((contract) => contract.invariants.map((inv) => ({ contract, inv })));
  return (
    <Cell span={7} pad="none" labelledBy="ledger-title">
      <SectionHead id="ledger-title" title="Invariant ledger" meta="Req 1" />
      <LedgerTable caption="Invariant ledger" columns={COLUMNS} rows={rows} rowKey={(r) => `${r.contract.contractId}/${r.inv.id}`} />
      <dl className="definition">
        <div>
          <dt className="label">Defined by</dt>
          <Provenance source={source} />
        </div>
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

import { shortHex } from '../../core/format';
import type { ContractSnapshot } from '../../core/model';
import { contractSeverity } from '../../core/severity';
import { Glyph } from '../primitives/Glyph';
import { LedgerTable, type Column } from '../primitives/LedgerTable';
import { Cell } from '../primitives/Sheet';
import { SectionHead } from '../primitives/Type';

const COLUMNS: readonly Column<ContractSnapshot>[] = [
  { key: 'id', header: 'Contract', render: (c) => c.contractId },
  { key: 'chain', header: 'Chain', render: (c) => c.chain },
  { key: 'address', header: 'Address', render: (c) => <span title={c.address}>{shortHex(c.address, 8, 6)}</span> },
  { key: 'block', header: 'Block', align: 'end', render: (c) => c.blockNumber.toString() },
  { key: 'mitigation', header: 'Mitigation', render: (c) => c.mitigation.state.replace('_', ' ').toUpperCase() },
  { key: 'paused', header: 'Paused', render: (c) => (c.paused ? 'YES' : 'NO') },
  {
    key: 'status',
    header: 'Status',
    render: (c) => {
      const s = contractSeverity(c);
      return <Glyph kind={s === 'critical' ? 'breach' : s === 'contained' ? 'contained' : 'holding'} />;
    },
    tone: (c) => {
      const s = contractSeverity(c);
      return s === 'nominal' ? undefined : s;
    },
  },
];

export function Contracts({ contracts }: { contracts: readonly ContractSnapshot[] }) {
  return (
    <Cell span={12} pad="none" labelledBy="contracts-title">
      <SectionHead id="contracts-title" title="Guarded contracts" meta={`${contracts.length} on watch`} />
      <LedgerTable caption="Guarded contracts" columns={COLUMNS} rows={contracts} rowKey={(c) => c.contractId} />
    </Cell>
  );
}

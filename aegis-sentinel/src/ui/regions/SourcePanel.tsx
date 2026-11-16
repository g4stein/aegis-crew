import { useState } from 'react';
import type { SentinelSnapshot, SourceKind } from '../../core/model';
import { overallSeverity } from '../../core/severity';
import { Button } from '../primitives/Button';
import { Mark } from '../primitives/Glyph';
import { SourceToggle } from '../primitives/SourceToggle';
import { Label } from '../primitives/Type';
import type { DataSource, Sources } from '../sources';

const OPTIONS = [
  { id: 'scripted' as const, label: 'Scripted' },
  { id: 'live-mock' as const, label: 'Live-mock' },
];

function ScriptedActions({ source, snapshot }: { source: Extract<DataSource, { id: 'scripted' }>; snapshot: SentinelSnapshot }) {
  const severity = overallSeverity(snapshot);
  return (
    <>
      <Button onClick={() => source.controls.simulateBreach()} disabled={severity !== 'nominal'}>
        <Mark shape="arrow-right" /> Simulate breach
      </Button>
      <Button onClick={() => source.controls.reset()} disabled={severity === 'nominal'}>
        <Mark shape="arrow-left" /> Reset
      </Button>
      <Label tone="ash">Scripted timeline in the browser. No chain, no MCP, no signing.</Label>
    </>
  );
}

function LiveActions({ source, snapshot }: { source: Extract<DataSource, { id: 'live-mock' }>; snapshot: SentinelSnapshot }) {
  const [busy, setBusy] = useState(false);
  const link = snapshot.source?.link ?? 'connecting';
  const host = snapshot.source?.host;
  const note =
    link !== 'open'
      ? host === 'browser'
        ? 'The in-tab runtime did not start. See the event log.'
        : 'Looking for a Node runtime (npm run -w aegis-sentinel runtime). Without one, the runtime starts in this tab.'
      : host === 'browser'
        ? 'Runtime loop, mock chain and Aegis Guard mirror run in this tab: the same code as the Node runtime, minus the MCP stdio hop. No keys. The fixture mis-credits shares 15 s after a (re)start.'
        : 'Runtime polls the chain-state MCP server over stdio. The fixture mis-credits shares 15 s after a (re)start.';
  const restart = () => {
    setBusy(true);
    void source.controls.restartMockChain().finally(() => setBusy(false));
  };
  return (
    <>
      <Button onClick={restart} disabled={busy || link !== 'open'}>
        <Mark shape="arrow-left" /> Restart mock chain
      </Button>
      <Label tone="ash">{note}</Label>
    </>
  );
}

/** Right-hand cell of the bulletin row: data-source switch plus source-specific actions. */
export function SourcePanel({ sources, selected, onSelect, snapshot }: { sources: Sources; selected: SourceKind; onSelect: (id: SourceKind) => void; snapshot: SentinelSnapshot }) {
  return (
    <div className="controls">
      <Label>Data source</Label>
      <SourceToggle label="Data source" options={OPTIONS} value={selected} onChange={onSelect} />
      <Label>{selected === 'scripted' ? 'Demo controls' : 'Mock chain'}</Label>
      {selected === 'scripted' ? <ScriptedActions source={sources.scripted} snapshot={snapshot} /> : <LiveActions source={sources['live-mock']} snapshot={snapshot} />}
    </div>
  );
}

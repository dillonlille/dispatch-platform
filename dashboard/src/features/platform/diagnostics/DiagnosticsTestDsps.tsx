import { FlaskConical } from 'lucide-react';
import { api } from '../../../app/api.js';
import { platformHash } from '../../../app/navigation.js';
import { useAction } from '../../../app/useAction.js';
import { Badge, DataTable, useDataTable, type TableColumn } from '../../../ui/index.js';
import { title } from '../../../lib/format.js';
import type { Diagnostics } from './types.js';

type TestDsp = Diagnostics['dsps'][number];
const columns: TableColumn<TestDsp>[] = [
  { id: 'dsp', header: 'DSP', rowHeader: true, cell: (dsp) => <strong>{dsp.name}</strong> },
  { id: 'status', header: 'Status', cell: (dsp) => <Badge value={dsp.status} /> },
  {
    id: 'data',
    header: 'Data',
    cell: (dsp) =>
      dsp.status === 'active' ? 'Synthetic data prepared · Available' : title(dsp.status),
  },
];

export function DiagnosticsTestDsps({
  diagnostics,
  refresh,
}: {
  diagnostics: Diagnostics;
  refresh: () => void;
}) {
  const deploy = useAction(
    async () => {
      await api('/api/platform/diagnostics', {});
      refresh();
    },
    { success: 'Test DSP ready' },
  );
  const table = useDataTable({ columns, rows: diagnostics.dsps, rowId: (dsp) => dsp.id });
  return (
    <section className="diagnostics-card" aria-labelledby="test-dsp-title">
      <div className="diagnostics-card-heading">
        <h2 id="test-dsp-title">Test DSPs</h2>
        <div>
          <a href={platformHash()} className="underlined-link">
            Manage test DSPs in DSPs
          </a>
          <button
            className="primary"
            disabled={deploy.busy || !diagnostics.enabled}
            onClick={() => void deploy.run()}
          >
            <FlaskConical size={16} />
            {deploy.busy ? 'Requesting test DSP…' : 'Deploy test DSP'}
          </button>
        </div>
      </div>
      {!diagnostics.enabled && (
        <div className="notice">Test DSP deployment is unavailable on this installation.</div>
      )}
      {diagnostics.dsps.length > 0 ? (
        <div className="table-wrap" aria-live="polite">
          <DataTable table={table} label="Test DSP deployments" />
        </div>
      ) : (
        <p className="muted">No test DSP is deployed.</p>
      )}
    </section>
  );
}

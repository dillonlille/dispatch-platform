import { useState } from 'react';
import { History, Plus } from 'lucide-react';
import type { DspView } from '../../../../shared/contracts/index.js';
import type { Uniform } from '../../../../shared/contracts/uniforms.js';
import { archiveUniform, initializeUniforms } from '../../app/endpoints.js';
import { can } from '../../app/permissions.js';
import { useAction } from '../../app/useAction.js';
import { ConfirmDialog, DataState, Empty, Header } from '../../ui/index.js';
import { useUniformInventory, type InventoryStatus } from './useUniformInventory.js';
import { UniformList } from './UniformList.js';
import { UniformDetail } from './UniformDetail.js';
import { UniformEditor } from './UniformEditor.js';
import { UniformHistory } from './UniformHistory.js';

const statusLabels: Record<InventoryStatus, string> = {
  live: 'Live',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  paused: 'Paused',
  unavailable: 'Unavailable',
};
export function UniformInventoryPage({ view }: { view: DspView }) {
  const inventory = useUniformInventory(view.token);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Uniform | 'new'>();
  const [archiving, setArchiving] = useState<Uniform>();
  const [history, setHistory] = useState(false);
  const canManage = can(view, 'uniforms.manage');
  const canAdjust = can(view, 'uniforms.adjust');
  const live = inventory.status === 'live';
  const setup = useAction(async (starter: boolean) =>
    inventory.accept(await initializeUniforms(starter)),
  );
  const archive = useAction(async () => {
    if (!archiving) return;
    inventory.accept(await archiveUniform(archiving.id, archiving.revision));
    setArchiving(undefined);
  });
  const uniforms = inventory.data?.uniforms ?? [];
  const active = uniforms.find((u) => u.id === selected) ?? uniforms[0];
  return (
    <>
      <Header title="Uniform Inventory">
        <div className="uniform-page-actions">
          <span className={`uniform-live ${live ? 'uniform-live-ready' : ''}`} role="status">
            <i />
            {statusLabels[inventory.status]}
          </span>
          <button onClick={() => setHistory(true)}>
            <History size={16} />
            History
          </button>
          {canManage && (
            <button className="primary" disabled={!live} onClick={() => setEditing('new')}>
              <Plus size={16} />
              Add uniform
            </button>
          )}
        </div>
      </Header>
      <DataState data={inventory.data} error={inventory.error}>
        {(data) =>
          active ? (
            <div className="uniform-browser">
              <UniformList
                uniforms={uniforms}
                selected={active.id}
                query={query}
                onQuery={setQuery}
                onSelect={setSelected}
                onAdd={canManage && live ? () => setEditing('new') : undefined}
                live={live}
              />
              <UniformDetail
                uniform={active}
                canAdjust={canAdjust}
                canManage={canManage}
                live={live}
                onEdit={() => setEditing(active)}
                onArchive={() => setArchiving(active)}
                onChange={inventory.acknowledge}
                refresh={inventory.refresh}
              />
            </div>
          ) : (
            <div className="uniform-empty">
              <Empty title="No uniforms yet" />
              {canManage && data.revision === 0 && (
                <div className="form-actions">
                  <button disabled={setup.busy || !live} onClick={() => void setup.run(false)}>
                    Start empty
                  </button>
                  <button
                    className="primary"
                    disabled={setup.busy || !live}
                    onClick={() => void setup.run(true)}
                  >
                    Use starter uniforms
                  </button>
                </div>
              )}
            </div>
          )
        }
      </DataState>
      {editing && (
        <UniformEditor
          uniform={editing === 'new' ? undefined : editing}
          categories={uniforms.map((u) => u.category)}
          onSave={inventory.accept}
          onClose={() => setEditing(undefined)}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          confirm="Archive uniform"
          busy={archive.busy}
          onConfirm={() => void archive.run()}
          onCancel={() => setArchiving(undefined)}
        >
          This removes the uniform from inventory. Its change history is kept.
        </ConfirmDialog>
      )}
      {history && (
        <UniformHistory
          revision={inventory.data?.revision ?? 0}
          timezone={view.dsp.timezone}
          onClose={() => setHistory(false)}
        />
      )}
    </>
  );
}

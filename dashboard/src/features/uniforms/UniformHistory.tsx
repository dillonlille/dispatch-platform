import { useState } from 'react';
import { uniformFitLabels } from '../../../../shared/contracts/uniforms.js';
import { useUniformHistory } from '../../app/endpoints.js';
import { DataState, Empty, Modal } from '../../ui/index.js';
import { time } from '../../lib/format.js';

export function UniformHistory({
  revision,
  timezone,
  onClose,
}: {
  revision: number;
  timezone: string;
  onClose: () => void;
}) {
  const [before, setBefore] = useState<number | null>(null);
  const query = useUniformHistory(before, revision);
  return (
    <Modal title="Inventory history" variant="sheet" onClose={onClose}>
      <DataState data={query.data} error={query.error}>
        {(data) => (
          <>
            {!data.events.length && <Empty title="No inventory changes yet" />}
            <ol className="uniform-history">
              {data.events.map((event) => (
                <li key={event.revision}>
                  <div>
                    <strong>
                      {event.kind === 'initialized' ? 'Inventory set up' : event.uniformName}
                    </strong>
                    <span>
                      {event.kind === 'adjusted'
                        ? `${event.fit ? uniformFitLabels[event.fit] : ''} · ${event.size} · ${event.quantity} in stock`
                        : event.kind === 'created'
                          ? 'Uniform created'
                          : event.kind === 'updated'
                            ? 'Uniform updated'
                            : event.kind === 'archived'
                              ? 'Uniform archived'
                              : ''}
                    </span>
                    <small>
                      {event.actorName} · {time(event.at, timezone)}
                    </small>
                  </div>
                  {event.delta !== null && (
                    <b className={event.delta > 0 ? 'uniform-history-add' : ''}>
                      {event.delta > 0 ? '+' : ''}
                      {event.delta}
                    </b>
                  )}
                </li>
              ))}
            </ol>
            <div className="uniform-history-paging">
              {before !== null && <button onClick={() => setBefore(null)}>Latest changes</button>}
              {data.nextBefore !== null && (
                <button onClick={() => setBefore(data.nextBefore)}>Older changes</button>
              )}
            </div>
          </>
        )}
      </DataState>
    </Modal>
  );
}

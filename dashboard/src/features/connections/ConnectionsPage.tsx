import { ShieldCheck } from 'lucide-react';
import { ConnectionCard } from './ConnectionCard.js';

export function ConnectionsPage({
  development,
  timezone,
}: {
  development: boolean;
  timezone: string;
}) {
  return (
    <section className="connections-view" aria-labelledby="connections-heading">
      <div>
        <h2 id="connections-heading">Connections</h2>
      </div>
      <div className="connection-cards">
        <ConnectionCard provider="paycom" development={development} timezone={timezone} />
        <ConnectionCard provider="cortex" development={development} timezone={timezone} />
      </div>
      <p className="connection-permissions muted">
        <ShieldCheck size={16} />
        DSP owners and platform owners can manage these credentials.
      </p>
    </section>
  );
}

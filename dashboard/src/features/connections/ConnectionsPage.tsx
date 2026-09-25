import { ShieldCheck } from 'lucide-react';
import type { Connection } from '../../../../shared/contracts/index.js';
import { ConnectionCard } from './ConnectionCard.js';

export function ConnectionsPage({
  development,
  timezone,
  providers,
}: {
  development: boolean;
  timezone: string;
  /** The connections the DSP has, in the order shown. */
  providers: readonly Connection['provider'][];
}) {
  return (
    <section className="connections-view" aria-labelledby="connections-heading">
      <div>
        <h2 id="connections-heading">Connections</h2>
      </div>
      <div className="connection-cards">
        {providers.map((provider) => (
          <ConnectionCard
            key={provider}
            provider={provider}
            development={development}
            timezone={timezone}
          />
        ))}
      </div>
      <p className="connection-permissions muted">
        <ShieldCheck size={16} />
        DSP owners and platform owners can manage these credentials.
      </p>
    </section>
  );
}

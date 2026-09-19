import { Building2 } from 'lucide-react';
import type { SessionView } from '../../../../shared/contracts/index.js';
import { Badge, Header } from '../../ui/index.js';
import { open } from './open.js';

// A member's platform page: the DSPs they belong to.
export function DspPicker({ session }: { session: SessionView }) {
  return (
    <>
      <Header title="Your DSPs" />
      <div className="workspace-grid">
        {session.dsps
          .filter((d) => d.status === 'active')
          .map((dsp) => (
            <button className="workspace-card" key={dsp.id} onClick={() => open(dsp)}>
              <Building2 />
              <strong>{dsp.name}</strong>
              <Badge value={dsp.environment} />
            </button>
          ))}
      </div>
      {!session.dsps.length && (
        <p>Your account has no DSP memberships. Ask your DSP owner for an invitation.</p>
      )}
    </>
  );
}

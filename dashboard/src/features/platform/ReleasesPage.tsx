import { RefreshCw } from 'lucide-react';
import { useData } from '../../app/api.js';
import { ErrorBox, Header, Loading } from '../../ui/index.js';
import { deviceTimezone, time, title } from '../../lib/format.js';

export function ReleasesPage() {
  const { data, error, refresh } = useData<{
    version?: string | null;
    release: string;
    update?: { status: string; commit?: string; updatedAt: string } | null;
  }>('/api/platform/releases', 5000);
  if (!data)
    return (
      <>
        <ErrorBox message={error} />
        <Loading />
      </>
    );
  return (
    <>
      <Header title="Updates">
        <button onClick={refresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </Header>
      <ErrorBox message={error} />
      <div id="platform-updates-content" className="archived-updates">
        {data.update && (
          <section className="archived-card update-status" role="status" aria-label="Update status">
            <h2>{title(data.update.status)}</h2>
            <p className="muted">
              Last update status {time(data.update.updatedAt, deviceTimezone())}
            </p>
          </section>
        )}
        {['Core', 'DSP'].map((product) => (
          <section
            key={product}
            className="archived-card archived-release-card"
            aria-label={`${product} release`}
          >
            <div className="release-card-heading">
              <div>
                <h2>{product}</h2>
                <p className="muted">Installed: {data.version ?? data.release.slice(0, 12)}</p>
              </div>
              <span className="muted">Updates automatically</span>
            </div>

            <div className="release-card-notes">
              <h3>{data.version ? `Version ${data.version}` : 'Current build'}</h3>

              <p className="muted">
                Build {data.release.slice(0, 12)}
                {data.update?.commit ? ` · Commit ${data.update.commit.slice(0, 12)}` : ''}
              </p>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

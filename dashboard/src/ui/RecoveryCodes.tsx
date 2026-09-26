import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';

const recoveryCodesText = (codes: string[]) =>
  [
    'DISPATCH RECOVERY CODES',
    '',
    ...codes.map((code, index) => `Code ${String(index + 1).padStart(2, '0')}: ${code}`),
  ].join('\n');

export function RecoveryCodes({ codes, done }: { codes: string[]; done: () => void }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const formatted = recoveryCodesText(codes);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };
  const download = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([formatted], { type: 'text/plain;charset=utf-8' }));
    link.download = 'dispatch-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <section className="recovery-codes" aria-labelledby="recovery-codes-title">
      <h2 id="recovery-codes-title" tabIndex={-1}>
        Save your recovery codes
      </h2>
      <p>
        Keep these somewhere safe outside Dispatch. Each code works once if you lose access to your
        passkeys and authenticator app. They won’t be shown again.
      </p>
      <div className="recovery-code-box">
        <div className="recovery-code-actions" role="group" aria-label="Recovery code actions">
          <button type="button" onClick={() => void copy()}>
            {copyStatus === 'copied' ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Copy size={15} aria-hidden="true" />
            )}
            {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
          <button type="button" onClick={download}>
            <Download size={15} aria-hidden="true" />
            Download
          </button>
        </div>
        <pre aria-label="Formatted recovery codes">{formatted}</pre>
      </div>
      <button className="primary" onClick={done}>
        I saved my recovery codes
      </button>
    </section>
  );
}

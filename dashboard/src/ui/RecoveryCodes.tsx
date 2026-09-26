export function RecoveryCodes({ codes, done }: { codes: string[]; done: () => void }) {
  return (
    <section className="recovery-codes" aria-labelledby="recovery-codes-title">
      <h2 id="recovery-codes-title">Save your recovery codes</h2>
      <p>
        Keep these somewhere safe outside Dispatch. Each code works once if you lose access to your
        passkeys and authenticator app. They won’t be shown again.
      </p>
      <pre>{codes.join('\n')}</pre>
      <button className="primary" onClick={done}>
        I saved my recovery codes
      </button>
    </section>
  );
}

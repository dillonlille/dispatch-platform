export function RecoveryCodes({ codes, done }: { codes: string[]; done: () => void }) {
  return (
    <section className="recovery-codes">
      <h2>Save your recovery codes</h2>
      <p>
        Keep these somewhere safe outside Dispatch. Each code works once if you lose access to your
        passkeys. These codes are only shown now.
      </p>
      <pre>{codes.join('\n')}</pre>
      <button className="primary" onClick={done}>
        I saved my recovery codes
      </button>
    </section>
  );
}

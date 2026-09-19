/** Keeps a client-side page inside the rows it slices. */
export function usePagination(page: number, total: number, pageSize: number) {
  const current = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  return { page: current, start: current * pageSize, end: (current + 1) * pageSize };
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  variant = 'range',
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /** `range` reads "1–100 of 240" before the buttons; `pages` reads "Page 1 of 3" between them. */
  variant?: 'range' | 'pages';
}) {
  if (!page && total <= pageSize) return null;
  const previous = (
    <button disabled={!page} onClick={() => onChange(page - 1)}>
      Previous
    </button>
  );
  const next = (
    <button disabled={(page + 1) * pageSize >= total} onClick={() => onChange(page + 1)}>
      Next
    </button>
  );
  return variant === 'range' ? (
    <div className="paycom-pagination">
      <span>
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      {previous}
      {next}
    </div>
  ) : (
    <div className="meal-pagination">
      {previous}
      <span>
        Page {page + 1} of {Math.ceil(total / pageSize)}
      </span>
      {next}
    </div>
  );
}

import { Ellipsis, Pencil, Plus, Shirt } from 'lucide-react';
import type { Uniform, UniformAdjustment } from '../../../../shared/contracts/uniforms.js';
import { uniformFits, uniformFitLabels } from '../../../../shared/contracts/uniforms.js';
import { Empty, Popover } from '../../ui/index.js';
import { uniformTotal } from '../../lib/uniforms.js';
import { StockCounter } from './StockCounter.js';

export function UniformDetail({
  uniform,
  canAdjust,
  canManage,
  live,
  onEdit,
  onArchive,
  onChange,
  refresh,
}: {
  uniform: Uniform;
  canAdjust: boolean;
  canManage: boolean;
  live: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onChange: (change: UniformAdjustment) => void;
  refresh: () => void;
}) {
  const fits = uniformFits.filter((fit) => uniform.variants.some((v) => v.fit === fit));
  const sizes = [...new Set(uniform.variants.map((v) => v.size))];
  const bySize = new Map(uniform.variants.map((v) => [`${v.fit}:${v.size}`, v]));
  return (
    <section className="uniform-detail" aria-label={uniform.name}>
      <div className="uniform-detail-heading">
        <span className="uniform-symbol">
          <Shirt size={20} />
        </span>
        <h2>{uniform.name}</h2>
        <div className="uniform-detail-actions">
          <span className="uniform-category">{uniform.category}</span>
          {canManage && (
            <>
              <button disabled={!live} onClick={onEdit}>
                <Pencil size={14} />
                Edit
              </button>
              <Popover
                className="row-menu"
                label={`Actions for ${uniform.name}`}
                trigger={<Ellipsis size={18} />}
                anchored
              >
                <button
                  disabled={!live || uniformTotal(uniform) > 0}
                  onClick={onArchive}
                  title={
                    uniformTotal(uniform) > 0
                      ? 'Remove the remaining stock before archiving'
                      : undefined
                  }
                >
                  Archive uniform
                </button>
              </Popover>
            </>
          )}
        </div>
      </div>
      {sizes.length ? (
        <div className="uniform-table-wrap">
          <table className="uniform-stock-table">
            <thead>
              <tr>
                <th scope="col">Size</th>
                {fits.map((fit) => (
                  <th scope="col" key={fit}>
                    {uniformFitLabels[fit]}
                  </th>
                ))}
                <th scope="col" className="uniform-availability">
                  Availability
                </th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((size) => {
                const stock = fits.reduce(
                  (sum, fit) => sum + (bySize.get(`${fit}:${size}`)?.quantity ?? 0),
                  0,
                );
                return (
                  <tr key={size}>
                    <th scope="row">{size}</th>
                    {fits.map((fit) => {
                      const variant = bySize.get(`${fit}:${size}`);
                      return (
                        <td key={fit}>
                          {variant ? (
                            <StockCounter
                              key={variant.id}
                              variant={variant}
                              uniformName={uniform.name}
                              canAdjust={canAdjust}
                              live={live}
                              onChange={onChange}
                              refresh={refresh}
                            />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="uniform-availability">
                      {live && (
                        <span
                          className={`uniform-stock-status ${stock === 0 ? 'uniform-stock-empty' : ''}`}
                        >
                          {stock === 0 ? 'Out of stock' : 'In stock'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No sizes added" />
      )}
      <div className="uniform-detail-footer">
        <span>
          {sizes.length} sizes · {live ? uniformTotal(uniform) : '—'} in stock
        </span>
        {canManage && (
          <button className="text-button" disabled={!live} onClick={onEdit}>
            <Plus size={14} />
            Add size
          </button>
        )}
      </div>
    </section>
  );
}

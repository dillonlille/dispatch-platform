import { Plus } from 'lucide-react';
import type { Uniform } from '../../../../shared/contracts/uniforms.js';
import { SearchInput } from '../../ui/index.js';
import { uniformTotal, groupUniforms } from '../../lib/uniforms.js';

export function UniformList({
  uniforms,
  selected,
  query,
  onQuery,
  onSelect,
  onAdd,
  live,
}: {
  uniforms: Uniform[];
  selected?: string;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onAdd?: () => void;
  live: boolean;
}) {
  const groups = groupUniforms(
    uniforms.filter((u) => `${u.name} ${u.category}`.toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <>
      <aside className="uniform-list" aria-label="Uniforms">
        <SearchInput
          label="Search uniforms"
          placeholder="Search uniforms…"
          value={query}
          onChange={onQuery}
        />
        <div className="uniform-list-items">
          {[...groups].map(([category, items]) => (
            <div className="uniform-list-group" key={category}>
              <h2>{category}</h2>
              {items.map((uniform) => (
                <button
                  key={uniform.id}
                  className="uniform-choice"
                  aria-pressed={selected === uniform.id}
                  onClick={() => onSelect(uniform.id)}
                >
                  <span>{uniform.name}</span>
                  <span className="uniform-list-count">{live ? uniformTotal(uniform) : '—'}</span>
                </button>
              ))}
            </div>
          ))}
          {!groups.size && <p className="uniform-no-results">No uniforms found</p>}
        </div>
        {onAdd && (
          <button className="text-button uniform-list-add" onClick={onAdd}>
            <Plus size={14} />
            Add uniform
          </button>
        )}
      </aside>
      <label className="uniform-mobile-picker">
        <span className="sr-only">Choose uniform</span>
        <select value={selected ?? ''} onChange={(e) => onSelect(e.target.value)}>
          {[...groupUniforms(uniforms)].map(([category, items]) => (
            <optgroup key={category} label={category}>
              {items.map((u) => (
                <option value={u.id} key={u.id}>
                  {u.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
    </>
  );
}

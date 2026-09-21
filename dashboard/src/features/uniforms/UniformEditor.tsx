import { useId, useState } from 'react';
import { X } from 'lucide-react';
import type {
  Uniform,
  UniformFit,
  UniformInput,
  UniformInventory,
} from '../../../../shared/contracts/uniforms.js';
import {
  uniformFits,
  uniformFitLabels,
  uniformSizePresets,
  uniformCategoryPresets,
} from '../../../../shared/contracts/uniforms.js';
import { saveUniform } from '../../app/endpoints.js';
import { useAction } from '../../app/useAction.js';
import { ErrorBox, Modal } from '../../ui/index.js';

type Size = UniformInput['variants'][number];
const splitSizes = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function UniformEditor({
  uniform,
  categories,
  onSave,
  onClose,
}: {
  uniform?: Uniform;
  categories: string[];
  onSave: (inventory: UniformInventory) => void;
  onClose: () => void;
}) {
  const categoryList = useId();
  const [variants, setVariants] = useState<Size[]>(
    () => uniform?.variants.map(({ id, fit, size }) => ({ id, fit, size })) ?? [],
  );
  const [fits, setFits] = useState<UniformFit[]>(() =>
    uniform?.variants.length
      ? uniformFits.filter((fit) => uniform.variants.some((v) => v.fit === fit))
      : ['men', 'women'],
  );
  const [drafts, setDrafts] = useState<Record<UniformFit, string>>({
    men: '',
    women: '',
    unisex: '',
  });
  const mergeSizes = (current: Size[], fit: UniformFit, sizes: string[]) => {
    const known = new Set(current.filter((v) => v.fit === fit).map((v) => v.size.toLowerCase()));
    return [
      ...current,
      ...sizes
        .filter((size) => {
          if (known.has(size.toLowerCase())) return false;
          known.add(size.toLowerCase());
          return true;
        })
        .map((size) => ({ fit, size })),
    ];
  };
  const add = (fit: UniformFit, sizes: string[]) =>
    setVariants((current) => mergeSizes(current, fit, sizes));
  const save = useAction(
    async (form: FormData) => {
      let submitted = variants.filter((v) => fits.includes(v.fit));
      for (const fit of fits) submitted = mergeSizes(submitted, fit, splitSizes(drafts[fit]));
      const result = await saveUniform(uniform?.id, {
        name: String(form.get('name')).trim(),
        category: String(form.get('category')).trim(),
        ...(uniform ? { revision: uniform.revision } : {}),
        variants: submitted,
      });
      onSave(result);
      onClose();
    },
    { inline: true },
  );
  return (
    <Modal title={uniform ? 'Edit uniform' : 'Add uniform'} onClose={() => !save.busy && onClose()}>
      <form
        className="uniform-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run(new FormData(event.currentTarget));
        }}
      >
        <fieldset disabled={save.busy}>
          <label>
            Uniform name
            <input
              name="name"
              defaultValue={uniform?.name}
              placeholder="e.g. Short Sleeve Polo"
              required
              maxLength={80}
            />
          </label>
          <label>
            Category
            <input
              name="category"
              defaultValue={uniform?.category ?? 'Tops'}
              list={categoryList}
              required
              maxLength={40}
            />
            <datalist id={categoryList}>
              {[...new Set([...uniformCategoryPresets, ...categories])].map((c) => (
                <option value={c} key={c} />
              ))}
            </datalist>
          </label>
          <fieldset className="uniform-fit-picker">
            <legend>Fits</legend>
            {uniformFits.map((fit) => (
              <label key={fit}>
                <input
                  type="checkbox"
                  checked={fits.includes(fit)}
                  onChange={(event) =>
                    setFits((current) =>
                      event.target.checked ? [...current, fit] : current.filter((f) => f !== fit),
                    )
                  }
                />
                {uniformFitLabels[fit]}
              </label>
            ))}
          </fieldset>
          {uniformFits
            .filter((fit) => fits.includes(fit))
            .map((fit) => (
              <fieldset className="uniform-size-editor" key={fit}>
                <legend>{uniformFitLabels[fit]} sizes</legend>
                <div className="uniform-size-presets">
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => add(fit, uniformSizePresets)}
                  >
                    XS–6XL
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => add(fit, ['One size'])}
                  >
                    One size
                  </button>
                </div>
                <div className="uniform-size-chips">
                  {variants
                    .filter((v) => v.fit === fit)
                    .map((v) => (
                      <button
                        key={`${fit}:${v.size}`}
                        type="button"
                        aria-label={`Remove ${uniformFitLabels[fit]} size ${v.size}`}
                        onClick={() =>
                          setVariants((current) => current.filter((other) => other !== v))
                        }
                      >
                        {v.size}
                        <X size={12} />
                      </button>
                    ))}
                </div>
                <label>
                  <span className="sr-only">Add {uniformFitLabels[fit]} sizes</span>
                  <input
                    value={drafts[fit]}
                    placeholder="Add sizes, separated by commas"
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [fit]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        add(fit, splitSizes(drafts[fit]));
                        setDrafts((current) => ({ ...current, [fit]: '' }));
                      }
                    }}
                  />
                </label>
              </fieldset>
            ))}
          <ErrorBox message={save.error} />
          <div className="form-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={!fits.length}>
              {save.busy ? 'Saving…' : uniform ? 'Save changes' : 'Create uniform'}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

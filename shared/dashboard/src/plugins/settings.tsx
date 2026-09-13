import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { activeMembership, isDspOwner, idempotent, request } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs.tsx";
import {
  ErrorNotice,
  Loading,
  Notice,
  PageHeading,
} from "../components/shared.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog.tsx";
import type {
  Input,
  Json,
  SettingsField,
  SettingsOption,
  SettingsSnapshot,
  SettingsSources,
} from "dispatch-sdk";
import "./settings.css";
import {
  conditionMatches,
  settingsIssues,
  settingsPreview,
  formatSettingValue,
  EFFECTS,
} from "dispatch-sdk/settings-behavior";
import { PluginSettingsHistory } from "./settings-history.tsx";

export function usePluginSettings<T = Input>(
  pluginId: string,
  includeOptions = false,
) {
  const { session } = useSession();
  const membership = activeMembership(session);
  const scope = `${session.user?.id}:${membership?.organizationId}:${session.dspView?.viewRef || "member"}`;
  const dspScope = `${membership?.organizationId}:${session.dspView?.viewRef || "member"}`;
  const base = `/api/organization/plugins/${encodeURIComponent(pluginId)}/settings`;
  const key = ["plugin-settings", pluginId, scope];
  const cache = useQueryClient();
  const enabled = session.authenticated && !!membership;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request<SettingsSnapshot<T>>(base, { signal }),
    enabled,
    refetchInterval: 15000,
  });
  const options = useQuery({
    queryKey: [...key, "options"],
    queryFn: ({ signal }) =>
      request<Record<string, SettingsOption[]>>(`${base}/options`, { signal }),
    enabled: enabled && includeOptions,
    staleTime: 30000,
  });
  const update = useMutation({
    mutationFn: ({
      values,
      snapshot,
      sources,
    }: {
      values: T;
      snapshot: SettingsSnapshot<T>;
      sources?: SettingsSources;
    }) =>
      idempotent<SettingsSnapshot<T>>(
        `plugin-settings:${pluginId}:${scope}:${snapshot.revision}`,
        base,
        {
          values,
          ...(sources ? { sources } : {}),
          expectedRevision: snapshot.revision,
          definitionVersion: snapshot.definitionVersion,
        },
      ),
    onSuccess: async (value) => {
      cache.setQueryData(key, value);
      await cache.invalidateQueries({
        predicate: (candidate) =>
          candidate.queryKey[0] !== "plugin-settings" &&
          String(candidate.queryKey[0]).startsWith(pluginId + "-") &&
          candidate.queryKey.some(
            (part) => part === scope || part === dspScope,
          ),
      });
    },
  });
  return { query, options, update, scope };
}

export function PluginSettingsField({
  field,
  value,
  options = {},
  disabled = false,
  onChange,
}: {
  field: SettingsField;
  value: Json;
  options?: Record<string, SettingsOption[]>;
  disabled?: boolean;
  onChange(value: Json): void;
}) {
  const source =
    field.options ||
    (field.optionsSource ? options[field.optionsSource] || [] : []);
  const id = `plugin-setting-${useId()}`;
  if (field.type === "boolean")
    return (
      <div className="plugin-setting-toggle">
        <div>
          <label htmlFor={id}>{field.label}</label>
          {field.description && <p>{field.description}</p>}
        </div>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </div>
    );
  if (field.type === "strings") {
    const selected =
      value === null
        ? source.map((item) => String(item.value))
        : (value as string[]);
    const known = new Map(source.map((item) => [String(item.value), item]));
    const ordered = [
      ...selected,
      ...source
        .map((item) => String(item.value))
        .filter((item) => !selected.includes(item)),
    ];
    function toggle(key: string, checked: boolean) {
      onChange(
        checked ? [...selected, key] : selected.filter((item) => item !== key),
      );
    }
    return (
      <fieldset className="plugin-setting-multiple" disabled={disabled}>
        <legend>{field.label}</legend>
        {field.description && <p>{field.description}</p>}
        {field.nullable && (
          <label className="plugin-setting-choice">
            <input
              type="checkbox"
              checked={value === null}
              onChange={(event) =>
                onChange(event.target.checked ? null : [...selected])
              }
            />
            Include all current and future options
          </label>
        )}
        <div className="plugin-setting-choices">
          {ordered.map((key, index) => {
            const option = known.get(key),
              checked = selected.includes(key);
            return (
              <div className="plugin-setting-option" key={key}>
                <label className="plugin-setting-choice">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={value === null}
                    onChange={(event) => toggle(key, event.target.checked)}
                  />
                  <span>
                    {option?.label || `${key} (not currently available)`}
                  </span>
                  {option?.count !== undefined && (
                    <span className="plugin-setting-count">{option.count}</span>
                  )}
                </label>
                {field.ordered && checked && (
                  <div className="plugin-setting-order">
                    {[-1, 1].map((direction) => (
                      <Button
                        key={direction}
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Move ${option?.label || key} ${direction < 0 ? "earlier" : "later"}`}
                        disabled={
                          disabled ||
                          index + direction < 0 ||
                          index + direction >= selected.length
                        }
                        onClick={() => {
                          const next = [...selected];
                          [next[index], next[index + direction]] = [
                            next[index + direction],
                            next[index],
                          ];
                          onChange(next);
                        }}
                      >
                        {direction < 0 ? "↑" : "↓"}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!ordered.length && <p>No options are available yet.</p>}
      </fieldset>
    );
  }
  if (source.length || field.optionsSource) {
    const unavailable =
      value !== null &&
      !source.some((option) => String(option.value) === String(value));
    return (
      <div className="plugin-setting-field">
        <label htmlFor={id}>{field.label}</label>
        <select
          id={id}
          value={value === null ? "" : String(value)}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value === "" && field.nullable
                ? null
                : field.type === "integer"
                  ? Number(event.target.value)
                  : event.target.value,
            )
          }
        >
          {field.nullable && (
            <option value="">All {field.optionsSource || "options"}</option>
          )}
          {unavailable && (
            <option value={String(value)}>
              {String(value)} (not currently available)
            </option>
          )}
          {source.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
        {field.description && <p>{field.description}</p>}
      </div>
    );
  }
  return (
    <div className="plugin-setting-field">
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        type={field.type === "integer" ? "number" : "text"}
        value={String(value ?? "")}
        min={field.minimum}
        max={field.maximum}
        maxLength={128}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            field.type === "integer"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
      {field.description && <p>{field.description}</p>}
    </div>
  );
}

function SettingsEditor({
  pluginId,
  title,
  description,
  backHref,
  renderSection,
}: {
  pluginId: string;
  title: string;
  description?: string;
  backHref: string;
  renderSection?(
    section: string,
    values: Input,
    options: Record<string, SettingsOption[]>,
  ): ReactNode;
}) {
  const { session } = useSession();
  const state = usePluginSettings(pluginId, true);
  const [base, setBase] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Input | null>(null);
  const [reset, setReset] = useState(false);
  const [draftSources, setDraftSources] = useState<SettingsSources>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [savedEffects, setSavedEffects] = useState<string[]>([]);
  const dirty =
    !!base &&
    (JSON.stringify(draft) !== JSON.stringify(base.values) ||
      JSON.stringify(draftSources) !== JSON.stringify(base.sources));
  useEffect(() => {
    if (state.query.data && !dirty) {
      setBase(state.query.data);
      setDraft(structuredClone(state.query.data.values));
      setDraftSources({ ...state.query.data.sources });
    }
  }, [state.query.data, dirty]);
  const newer =
    !!base &&
    !!state.query.data &&
    (base.revision !== state.query.data.revision ||
      base.definitionVersion !== state.query.data.definitionVersion);
  if (!isDspOwner(session))
    return <Notice>Your DSP owner can manage plugin settings.</Notice>;
  if (state.query.isPending) return <Loading />;
  if (!base || !draft)
    return (
      <>
        <ErrorNotice error={state.query.error} />
        <Button onClick={() => void state.query.refetch()}>
          Retry settings
        </Button>
      </>
    );
  const options = state.options.data || {},
    busy = state.update.isPending;
  const issues = settingsIssues(base.definition, draft);
  const invalid = issues.some((issue) => issue.severity === "error");
  async function save() {
    if (!base || !draft) return;
    try {
      const saved = await state.update.mutateAsync({
        values: draft,
        snapshot: base,
        sources: draftSources,
      });
      const timing = new Set(
        base.definition.fields
          .filter(
            (field) =>
              JSON.stringify(base.values[field.id]) !==
              JSON.stringify(saved.values[field.id]),
          )
          .map((field) => field.applies)
          .filter((value) => value !== undefined),
      );
      setSavedEffects([...timing].map((value) => EFFECTS[value]));
      setBase(saved);
      setDraft(structuredClone(saved.values));
      setDraftSources({ ...saved.sources });
      setDraftNote("");
    } catch {
      /* Display the scoped error below. */
    }
  }
  function discard() {
    const value = state.query.data || base;
    if (value) {
      setBase(value);
      setDraft(structuredClone(value.values));
      setDraftSources({ ...value.sources });
      setDraftNote("");
      setSavedEffects([]);
      state.update.reset();
    }
  }
  function restore(values: Input, sources: SettingsSources, fields: string[]) {
    setDraft((current) => ({
      ...current,
      ...Object.fromEntries(
        fields.map((id) => [
          id,
          structuredClone(
            sources[id] === "default"
              ? base!.definition.fields.find((field) => field.id === id)!
                  .default
              : values[id],
          ),
        ]),
      ),
    }));
    setDraftSources((current) => ({
      ...current,
      ...Object.fromEntries(fields.map((id) => [id, sources[id]])),
    }));
    setDraftNote(
      "Restored into your draft. Review your changes before saving.",
    );
    state.update.reset();
  }
  function defaults(fields: string[]) {
    restore(
      Object.fromEntries(
        base!.definition.fields.map((field) => [field.id, field.default]),
      ),
      Object.fromEntries(fields.map((id) => [id, "default"])),
      fields,
    );
  }
  return (
    <div className="plugin-settings-page">
      <a className="plugin-settings-back" href={backHref}>
        ← Back
      </a>
      <PageHeading title={title} description={description} />
      <ErrorNotice
        error={state.query.error || state.options.error || state.update.error}
      />
      {newer && (
        <Notice>
          These settings changed in another session. Discard your draft to load
          the latest settings before saving.
        </Notice>
      )}
      {draftNote && <Notice>{draftNote}</Notice>}
      {issues.map((issue) => (
        <p
          key={issue.id}
          className="plugin-settings-rule"
          role={issue.severity === "error" ? "alert" : "status"}
        >
          {issue.message}
        </p>
      ))}
      <Tabs defaultValue={base.definition.sections[0].id}>
        <TabsList variant="line" aria-label={`${title} sections`}>
          {base.definition.sections.map((section) => (
            <TabsTrigger key={section.id} value={section.id}>
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {base.definition.sections.map((section) => (
          <TabsContent key={section.id} value={section.id}>
            {section.description && (
              <p className="plugin-settings-description">
                {section.description}
              </p>
            )}
            <div className="plugin-settings-fields">
              {base.definition.fields
                .filter(
                  (field) =>
                    field.section === section.id &&
                    conditionMatches(field.visibleWhen, draft),
                )
                .map((field) => (
                  <div
                    key={field.id}
                    className={
                      field.type === "boolean" || field.type === "strings"
                        ? "plugin-setting-wide"
                        : ""
                    }
                  >
                    <PluginSettingsField
                      field={field}
                      value={draft[field.id]}
                      options={options}
                      disabled={
                        busy ||
                        !conditionMatches(field.enabledWhen, draft) ||
                        (!!field.optionsSource && state.options.isPending)
                      }
                      onChange={(value) => {
                        setDraft((current) => ({
                          ...current,
                          [field.id]: value,
                        }));
                        setDraftSources((current) => ({
                          ...current,
                          [field.id]: "override",
                        }));
                        setDraftNote("");
                        state.update.reset();
                      }}
                    />
                    {!conditionMatches(field.enabledWhen, draft) &&
                      field.disabledReason && (
                        <p className="plugin-setting-help">
                          {field.disabledReason}
                        </p>
                      )}
                    <div className="plugin-setting-source">
                      <span>
                        {draftSources[field.id] === "default"
                          ? "Plugin default"
                          : "DSP override"}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={
                          draftSources[field.id] === "default"
                            ? `Keep current value for ${field.label}`
                            : `Use plugin default for ${field.label}`
                        }
                        onClick={() =>
                          draftSources[field.id] === "default"
                            ? setDraftSources((current) => ({
                                ...current,
                                [field.id]: "override",
                              }))
                            : defaults([field.id])
                        }
                      >
                        {draftSources[field.id] === "default"
                          ? "Keep this value"
                          : "Use plugin default"}
                      </Button>
                    </div>
                    <p className="plugin-setting-help">
                      Default:{" "}
                      {formatSettingValue(field, field.default, options)}
                    </p>
                  </div>
                ))}
            </div>
            {(base.definition.previews || [])
              .filter((preview) => preview.section === section.id)
              .map((preview) => (
                <p
                  key={preview.id}
                  role="status"
                  className="plugin-settings-preview"
                >
                  {preview.label}:{" "}
                  {settingsPreview(
                    preview,
                    draft,
                    base.definition.fields,
                    options,
                  )}
                </p>
              ))}
            {renderSection?.(section.id, draft, options)}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                defaults(
                  base.definition.fields
                    .filter((field) => field.section === section.id)
                    .map((field) => field.id),
                )
              }
            >
              Restore {section.label} defaults
            </Button>
          </TabsContent>
        ))}
      </Tabs>
      <div className="plugin-settings-defaults">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setReset(true)}
        >
          Restore defaults
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-expanded={historyOpen}
        >
          Change history
        </Button>
        <span>Settings apply to this DSP.</span>
      </div>
      {historyOpen && (
        <PluginSettingsHistory
          key={state.scope}
          pluginId={pluginId}
          scope={state.scope}
          snapshot={base}
          busy={busy || newer}
          onRestore={restore}
        />
      )}
      {!dirty &&
        savedEffects.map((message) => (
          <p className="plugin-settings-effect" key={message} role="status">
            {message}
          </p>
        ))}
      <footer className="plugin-settings-footer">
        <span role="status">
          {dirty
            ? "You have unsaved changes"
            : base.appliedRevision !== base.revision
              ? "Saved. Applying settings…"
              : state.update.isSuccess
                ? "Settings saved"
                : "All changes saved"}
        </span>
        <div>
          <Button variant="outline" disabled={!dirty || busy} onClick={discard}>
            Discard
          </Button>
          <Button
            disabled={!dirty || busy || newer || invalid}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </footer>
      <Dialog open={reset} onOpenChange={setReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore plugin defaults?</DialogTitle>
            <DialogDescription>
              Your connection and collected records are preserved. Review the
              defaults before saving.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReset(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                defaults(base.definition.fields.map((field) => field.id));
                setReset(false);
              }}
            >
              Restore defaults
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// A draft is owned by one authenticated DSP view. Switching scope remounts the
// editor before another DSP can receive any of its unsaved values or intent.
export function PluginSettingsForm(
  props: ComponentProps<typeof SettingsEditor>,
) {
  const { session } = useSession();
  const scope = `${props.pluginId}:${session.user?.id}:${activeMembership(session)?.organizationId}:${session.dspView?.viewRef || "member"}`;
  return <SettingsEditor key={scope} {...props} />;
}

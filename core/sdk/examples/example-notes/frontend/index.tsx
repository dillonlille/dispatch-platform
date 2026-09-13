import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ErrorNotice, Loading, Notice, PageHeading, PluginSettingsForm, TextField,
  invokePluginOperation, usePluginSettings, Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "dispatch-sdk/ui";
import { createClient } from "../generated/client";

const id = "example-notes";
const api = createClient((action, input, options) => invokePluginOperation(id, action, input, options));
function Records({ scope, allowEntries }: { scope: string; allowEntries: boolean }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [offset, setOffset] = useState(0);
  const records = useQuery({ queryKey: [id, scope, "records", offset],
    queryFn: ({ signal }) => api["records.list"]({ limit: 25, offset }, { signal }) });
  const add = useMutation({ mutationFn: () => api["records.add"]({ text, idempotencyKey: requestId }),
    onSuccess: async () => { setText(""); setRequestId(crypto.randomUUID()); setOffset(0); await queryClient.invalidateQueries({ queryKey: [id, scope, "records"] }); } });
  return <>
    <form className="flex items-end gap-3" onSubmit={event => { event.preventDefault(); if (!add.isPending && allowEntries) add.mutate(); }}>
      <TextField label="New entry" value={text} onChange={event => { setText(event.target.value); setRequestId(crypto.randomUUID()); }} required maxLength={200} disabled={add.isPending || !allowEntries} />
      <Button type="submit" disabled={add.isPending || !allowEntries || !text.trim()}>{add.isPending ? "Saving…" : "Add entry"}</Button>
    </form>
    {!allowEntries ? <Notice>New entries are paused for this DSP.</Notice> : null}
    <ErrorNotice error={add.error || records.error} />
    {records.isPending ? <Loading /> : records.data ? <>
      <Table><TableHeader><TableRow><TableHead>Entry</TableHead></TableRow></TableHeader>
        <TableBody>{records.data.items.length ? records.data.items.map(row => <TableRow key={row.id}><TableCell>{row.text}</TableCell></TableRow>)
          : <TableRow><TableCell>No entries yet.</TableCell></TableRow>}</TableBody></Table>
      <div className="flex gap-3"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
        <Button disabled={offset + 25 >= records.data.total} onClick={() => setOffset(offset + 25)}>Next</Button></div>
    </> : null}
  </>;
}
function Page() {
  const settings = usePluginSettings(id);
  if (new URLSearchParams(location.hash.split("?")[1] || "").has("settings"))
    return <PluginSettingsForm pluginId={id} title="Example Notes settings" backHref={`#/${id}`} />;
  if (settings.query.isPending) return <Loading />;
  if (settings.query.error) return <ErrorNotice error={settings.query.error} />;
  return <section className="space-y-5">
    <PageHeading title="Example Notes" description="Entries are saved for your DSP."><a href={`#/${id}?settings`}>Settings</a></PageHeading>
    <Records key={settings.scope} scope={settings.scope} allowEntries={settings.query.data?.values.allow_entries === true} />
  </section>;
}
export default { id, pages: { [id]: Page } };

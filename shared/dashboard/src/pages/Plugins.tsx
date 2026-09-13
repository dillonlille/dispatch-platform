import { useState } from "react";
import { Puzzle } from "lucide-react";
import {
  activeMembership,
  idempotent,
  isDspOwner,
  isPlatform,
  queryClient,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { usePlugins, type PluginView } from "@/plugins/registry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ErrorNotice, Loading, Notice, PageHeading } from "@/components/shared";

export function Plugins() {
  const { session, refresh } = useSession();
  const platform = isPlatform(session);
  const owner = isDspOwner(session);
  const query = usePlugins(session);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<PluginView | null>(null);
  async function change(plugin: PluginView, action: string) {
    setBusy(plugin.id);
    setError(null);
    try {
      await idempotent(
        `plugin:${plugin.id}:${action}:${plugin.revision}`,
        `/api/organization/plugins/${plugin.id}`,
        { action, expectedRevision: plugin.revision },
      );
      setRemoving(null);
      await query.refetch();
      await queryClient.invalidateQueries({
        queryKey: ["connections", activeMembership(session)?.organizationId],
      });
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        title="Plugins"
        description={
          platform
            ? "Available plugins that DSP owners can install for their workspace."
            : "Choose the features your DSP uses. Your saved data stays with your DSP."
        }
      />
      <ErrorNotice error={error || query.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {query.data?.items.map((plugin) => (
            <Card key={plugin.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <Puzzle
                    aria-hidden="true"
                    className="size-5 text-muted-foreground"
                  />
                  {!platform && (
                    <Badge variant="secondary">
                      {plugin.pending
                        ? "Applying changes"
                        : plugin.state === "enabled"
                          ? "Installed"
                          : plugin.state === "disabled"
                            ? "Disabled"
                            : "Not installed"}
                    </Badge>
                  )}
                </div>
                <CardTitle>{plugin.name}</CardTitle>
                <CardDescription>{plugin.description}</CardDescription>
              </CardHeader>
              <CardContent>
                {plugin.failureCode ? (
                  <Notice error>
                    We couldn’t finish applying this change. Dispatch will retry
                    when your DSP is available.
                  </Notice>
                ) : plugin.pending ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Updating this plugin for your DSP…
                  </p>
                ) : !platform && plugin.state === "disabled" ? (
                  <p className="text-sm text-muted-foreground">
                    Its pages and background work are stopped. Your saved data
                    and credentials are retained.
                  </p>
                ) : null}
              </CardContent>
              {!platform && owner && (
                <CardFooter className="flex flex-wrap gap-2">
                  {plugin.state === "uninstalled" ? (
                    <Button
                      disabled={!!busy || plugin.pending}
                      onClick={() => void change(plugin, "install")}
                    >
                      Install {plugin.name}
                    </Button>
                  ) : (
                    <>
                      {plugin.available && plugin.pages[0] && (
                        <Button asChild>
                          <a href={`#/${plugin.pages[0].id}`}>
                            Open {plugin.name}
                          </a>
                        </Button>
                      )}
                      {plugin.available &&
                        plugin.hasSettings &&
                        plugin.pages[0] && (
                          <Button asChild variant="outline">
                            <a href={`#/${plugin.pages[0].id}?settings`}>
                              Settings
                            </a>
                          </Button>
                        )}
                      <Button
                        variant="outline"
                        disabled={!!busy || plugin.pending}
                        onClick={() =>
                          void change(
                            plugin,
                            plugin.state === "disabled" ? "enable" : "disable",
                          )
                        }
                      >
                        {plugin.state === "disabled" ? "Enable" : "Disable"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!busy || plugin.pending}
                        onClick={() => setRemoving(plugin)}
                      >
                        Uninstall
                      </Button>
                    </>
                  )}
                </CardFooter>
              )}
            </Card>
          ))}
        </div>
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {removing?.name}?</DialogTitle>
            <DialogDescription>
              Its pages and background work will stop. Your collected data and
              saved credentials will stay with this DSP so you can reinstall it
              later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!!busy}
              onClick={() => removing && void change(removing, "uninstall")}
            >
              Uninstall plugin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

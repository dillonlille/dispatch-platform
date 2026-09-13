import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { ApiError, request } from "../lib/api.ts";
import { ErrorNotice, Loading } from "../components/shared.tsx";
import { frontend } from "./host.ts";

type Asset = { id: string; version: string; revision: number; javascript: string; stylesheet: string };
const pages = new Map<string, ComponentType>();
const loads = new Map<string, Promise<void>>();
window.addEventListener("dispatch-authority-changed", () => { pages.clear(); loads.clear(); });
async function load(id: string, version: string, revision: number) {
  const value = await request<Asset>(`/api/plugin-assets/${id}/${revision}`);
  if (value.id !== id || value.version !== version || value.revision !== revision
      || typeof value.javascript !== "string" || value.javascript.length > 2 * 1024 * 1024
      || typeof value.stylesheet !== "string" || value.stylesheet.length > 1024 * 1024) throw new ApiError("plugin_unavailable");
  const nonce = document.querySelector<HTMLMetaElement>("meta[name=dispatch-style-nonce]")?.content;
  if (!nonce) throw new ApiError("plugin_unavailable");
  const script = document.createElement("script"); script.nonce = nonce; script.textContent = value.javascript;
  document.head.append(script); script.remove();
  if (!frontend(id, version)) throw new ApiError("plugin_unavailable");
  const style = document.createElement("style"); style.nonce = nonce; style.textContent = value.stylesheet;
  style.dataset.dispatchPlugin = `${id}@${version}`; document.head.append(style);
}
export function installedPage(id: string, version: string, revision: number, page: string): ComponentType {
  const identity = `${id}@${version}:${revision}`, key = `${identity}/${page}`;
  let component = pages.get(key);
  if (!component) {
    component = lazy(async () => {
      if (!frontend(id, version)) {
        let pending = loads.get(identity);
        if (!pending) {
          pending = load(id, version, revision).catch(error => { loads.delete(identity); throw error; });
          loads.set(identity, pending);
        }
        await pending;
      }
      const selected = frontend(id, version)?.pages[page];
      if (!selected) throw new ApiError("plugin_unavailable");
      return { default: selected };
    });
    if (pages.size >= 128) pages.delete(pages.keys().next().value!);
    pages.set(key, component);
  }
  return component;
}
export class PluginBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() { return this.state.error ? <ErrorNotice error={this.state.error} /> : <Suspense fallback={<Loading />}>{this.props.children}</Suspense>; }
}

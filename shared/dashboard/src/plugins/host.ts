import * as react from "react";
import * as jsx from "react/jsx-runtime";
import * as query from "@tanstack/react-query";
import * as ui from "./ui.ts";
import type { ComponentType } from "react";

export type PluginFrontend = { apiVersion: 1; id: string; version: string; pages: Record<string, ComponentType> };
const registered = new Map<string, PluginFrontend>();
export const frontend = (id: string, version: string) => registered.get(`${id}@${version}`);
Object.defineProperty(globalThis, "DispatchPluginHost", { value: Object.freeze({
  react, jsx, query, ui,
  register(value: PluginFrontend) {
    if (value.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)
        || !/^\d+\.\d+\.\d+$/.test(value.version) || !value.pages
        || Object.values(value.pages).some(page => typeof page !== "function")) throw new Error("Plugin interface unavailable");
    if (registered.size >= 64) throw new Error("Plugin limit reached");
    registered.set(`${value.id}@${value.version}`, Object.freeze(value));
  },
}), writable: false, configurable: false });

import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/api.ts";
import { App } from "./App.tsx";
import "./styles.css";
import "./polish.css";
import "./updates.css";
import { setNonce } from "get-nonce";
const nonce = document.querySelector<HTMLMetaElement>(
  "meta[name=dispatch-style-nonce]",
)?.content;
if (nonce) setNonce(nonce);
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);

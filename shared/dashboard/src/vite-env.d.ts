/// <reference types="vite/client" />

interface Window {
  __dispatchDashboard?: { product: "core" | "dsp"; digest: string };
}

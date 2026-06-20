import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/newsreader/standard-italic.css";
import "./styles/base.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/Toast.js";
import { queryClient } from "./lib/query.js";
import { SkinSync } from "./lib/skin.js";
import { ThemeProvider } from "./lib/theme.js";
import { router } from "./router.js";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");

createRoot(el).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Applies the instance design skin from /api/me to <html data-skin>. */}
        <SkinSync />
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

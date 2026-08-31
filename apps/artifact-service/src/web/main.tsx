import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { applyPublicTheme, readPublicTheme } from "./components/public-chrome";
import "./styles.css";

applyPublicTheme(readPublicTheme());

const root = document.querySelector<HTMLElement>("#root");

if (!root) {
  throw new Error("Missing application root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

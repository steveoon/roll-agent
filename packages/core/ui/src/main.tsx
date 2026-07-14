import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Roll UI root element is missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

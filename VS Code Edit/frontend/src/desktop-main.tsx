import React from "react";
import ReactDOM from "react-dom/client";
import DesktopConnectionPage from "./pages/DesktopConnectionPage";
import "./desktop.css";

ReactDOM.createRoot(document.getElementById("desktop-root")!).render(
  <React.StrictMode>
    <DesktopConnectionPage />
  </React.StrictMode>,
);

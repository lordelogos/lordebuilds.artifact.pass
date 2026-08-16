import { UploadPage } from "./routes/upload-page";

export function App() {
  if (window.location.pathname === "/upload") return <UploadPage />;
  return <main className="not-found"><p>There is nothing at this address.</p></main>;
}

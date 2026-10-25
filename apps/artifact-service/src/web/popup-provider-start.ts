// The provider may isolate its window with COOP, making a live popup look closed to its opener.
export const popupProviderStartScript = `(() => {
  const returnTo = new URLSearchParams(window.location.search).get("return_to");
  if (returnTo === null || !returnTo.startsWith("/auth/popup/complete?")) return;
  const flow = new URL(returnTo, window.location.origin).searchParams.get("flow");
  if (flow === null || !/^[0-9a-f]{32}$/.test(flow)) return;
  for (const provider of document.querySelectorAll("a.provider")) {
    provider.addEventListener("click", () => {
      const message = { type: "artifactpass:auth-provider-started", flow };
      try {
        window.opener?.postMessage(message, window.location.origin);
      } catch {}
      if ("BroadcastChannel" in window) {
        try {
          const channel = new BroadcastChannel("artifactpass-auth");
          channel.postMessage(message);
          channel.close();
        } catch {}
      }
    });
  }
})();`;

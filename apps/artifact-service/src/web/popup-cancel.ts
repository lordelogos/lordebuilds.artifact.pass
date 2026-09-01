export const popupCancelledScript = `(() => {
  const navigateToApp = () => {
    try {
      sessionStorage.setItem("artifactpass-pending-upload", "1");
    } catch {}
    window.location.assign("/?upload=1&auth=cancelled");
  };
  const returnToApp = () => {
    const flow = new URLSearchParams(window.location.search).get("flow");
    if (flow !== null && "BroadcastChannel" in window) {
      try {
        const channel = new BroadcastChannel("artifactpass-auth");
        channel.postMessage({ type: "artifactpass:auth-cancelled", flow });
        channel.close();
      } catch {}
    }
    if (window.opener !== null && !window.opener.closed) {
      try {
        window.opener.postMessage({ type: "artifactpass:auth-cancelled", flow }, window.location.origin);
      } catch {}
      try {
        window.opener.focus();
      } catch {}
      try {
        window.close();
      } catch {}
      window.setTimeout(navigateToApp, 500);
      return;
    }
    try {
      window.close();
    } catch {}
    window.setTimeout(navigateToApp, 500);
  };
  document.querySelector("#return-to-app")?.addEventListener("click", navigateToApp);
  returnToApp();
})();`;

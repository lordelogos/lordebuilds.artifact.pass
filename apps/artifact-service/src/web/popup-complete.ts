export const popupCompleteScript = `(() => {
  const flow = new URLSearchParams(window.location.search).get("flow");
  try {
    sessionStorage.setItem("artifactpass-pending-upload", "1");
  } catch {}
  if (flow !== null && "BroadcastChannel" in window) {
    try {
      const channel = new BroadcastChannel("artifactpass-auth");
      channel.postMessage({ type: "artifactpass:auth-complete", flow });
      channel.close();
    } catch {}
  }
  if (window.opener !== null && !window.opener.closed) {
    try {
      window.opener.postMessage({ type: "artifactpass:auth-complete", flow }, window.location.origin);
    } catch {}
    try {
      window.opener.focus();
    } catch {}
    try {
      window.close();
    } catch {}
    window.setTimeout(() => {
      const status = document.querySelector("#popup-status");
      if (status !== null) status.textContent = "You can return to the ArtifactPass tab.";
    }, 500);
    return;
  }
  document.querySelector("#completion-fallback")?.removeAttribute("hidden");
  try {
    window.close();
  } catch {}
  window.setTimeout(() => {
    const status = document.querySelector("#popup-status");
    if (status !== null) status.textContent = "Return to your original ArtifactPass tab, or continue here.";
  }, 500);
})();`;

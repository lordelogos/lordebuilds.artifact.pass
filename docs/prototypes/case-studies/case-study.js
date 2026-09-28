document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const wrapper = button.closest(".command");
    const code = wrapper?.querySelector("code");
    if (!code) return;

    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(code.textContent ?? "");
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select text";
    }

    window.setTimeout(() => {
      button.textContent = original;
    }, 1800);
  });
});

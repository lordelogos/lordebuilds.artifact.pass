import { describe, expect, it, vi } from "vitest";

import { promptForMultipleChoices } from "../src/terminal-prompt";

describe("terminal prompt helpers", () => {
  it("preserves the plain prompt behavior by accepting repeated selections once", async () => {
    const question = vi.fn().mockResolvedValue("1,1,3");

    await expect(promptForMultipleChoices(
      { question, write: vi.fn() },
      "Choose options",
      ["first", "second", "third"],
      (value) => value,
    )).resolves.toEqual(["first", "third"]);
  });
});

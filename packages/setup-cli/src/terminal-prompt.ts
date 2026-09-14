import { createInterface } from "node:readline/promises";

export interface TerminalActivity {
  readonly update: (message: string) => void;
  readonly succeed: (message: string) => void;
  readonly fail: (message: string) => void;
}

export interface TerminalPrompt {
  readonly interactive?: boolean;
  readonly question: (message: string) => Promise<string>;
  readonly write: (message: string) => void;
  readonly select?: (message: string, options: readonly string[]) => Promise<number>;
  readonly multiselect?: (message: string, options: readonly string[]) => Promise<readonly number[]>;
  readonly text?: (message: string, placeholder?: string) => Promise<string>;
  readonly intro?: (message: string) => void;
  readonly note?: (message: string, title?: string) => void;
  readonly outro?: (message: string) => void;
  readonly activity?: (message: string) => TerminalActivity;
}

export type InteractiveTerminalPrompt = TerminalPrompt & { readonly interactive: boolean };

export class TerminalPromptCancelledError extends Error {
  constructor(readonly resumeCommand?: string) {
    super("ArtifactPass setup cancelled");
  }
}

export const createNonInteractiveTerminalPrompt = (): InteractiveTerminalPrompt => ({
  interactive: false,
  question: async () => {
    throw new Error("ArtifactPass needs an interactive terminal for this question");
  },
  write: (message) => process.stderr.write(message),
});

export const createTerminalPrompt = async (): Promise<InteractiveTerminalPrompt> => {
  const clack = await import("@clack/prompts");
  const promptOptions = { input: process.stdin, output: process.stderr } as const;
  const resultOrCancel = <Value>(result: Value | typeof clack.CANCEL_SYMBOL): Value => {
    if (clack.isCancel(result)) throw new TerminalPromptCancelledError();
    return result;
  };

  return {
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    question: async (message) => {
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        return await reader.question(message, { signal: controller.signal });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new TerminalPromptCancelledError();
        }
        throw error;
      } finally {
        process.off("SIGINT", interrupt);
        reader.close();
      }
    },
    write: (message) => process.stderr.write(message),
    select: async (message, options) => resultOrCancel(await clack.select({
      ...promptOptions,
      message,
      options: options.map((label, index) => ({ value: index, label })),
    })),
    multiselect: async (message, options) => resultOrCancel(await clack.multiselect({
      ...promptOptions,
      message,
      options: options.map((label, index) => ({ value: index, label })),
      required: true,
    })),
    text: async (message, placeholder) => resultOrCancel(await clack.text({
      ...promptOptions,
      message,
      ...(placeholder === undefined ? {} : { placeholder }),
      validate: (input) => (input ?? "").trim().length === 0 ? "This field is required" : undefined,
    })),
    intro: (message) => clack.intro(message, promptOptions),
    note: (message, title) => clack.note(message, title, promptOptions),
    outro: (message) => clack.outro(message, promptOptions),
    activity: (message) => {
      const activity = clack.spinner({
        indicator: "timer",
        output: process.stderr,
      });
      activity.start(message);
      return {
        update: (nextMessage) => activity.message(nextMessage),
        succeed: (finalMessage) => activity.stop(finalMessage),
        fail: (finalMessage) => activity.error(finalMessage),
      };
    },
  };
};

export const promptForText = async (
  prompt: TerminalPrompt,
  message: string,
  placeholder?: string,
): Promise<string> => prompt.text === undefined
  ? prompt.question(`${message}\n> `)
  : prompt.text(message, placeholder);

export const promptForChoice = async (
  prompt: TerminalPrompt,
  message: string,
  options: readonly string[],
): Promise<number> => {
  if (prompt.select !== undefined) {
    const selected = await prompt.select(message, options);
    if (Number.isInteger(selected) && options[selected] !== undefined) return selected;
    throw new Error(`Prompt returned an invalid choice for ${message}`);
  }
  for (;;) {
    const answer = await prompt.question(`${message}\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n> `);
    const selected = Number.parseInt(answer.trim(), 10) - 1;
    if (Number.isInteger(selected) && options[selected] !== undefined) return selected;
    prompt.write(`Choose a number from 1 to ${options.length}.\n`);
  }
};

const selectedOptions = <Value>(
  options: readonly Value[],
  indexes: readonly number[],
): readonly Value[] | null => {
  const uniqueIndexes = [...new Set(indexes)];
  if (uniqueIndexes.length === 0) return null;
  const selected: Value[] = [];
  for (const index of uniqueIndexes) {
    const option = options[index];
    if (!Number.isInteger(index) || option === undefined) return null;
    selected.push(option);
  }
  return selected;
};

export const promptForMultipleChoices = async <Value>(
  prompt: TerminalPrompt,
  message: string,
  options: readonly Value[],
  label: (option: Value, index: number) => string,
): Promise<readonly Value[]> => {
  const labels = options.map(label);
  if (prompt.multiselect !== undefined) {
    const selected = selectedOptions(options, await prompt.multiselect(message, labels));
    if (selected !== null) return selected;
    throw new Error(`Prompt returned an invalid selection for ${message}`);
  }
  for (;;) {
    const answer = await prompt.question([
      message,
      ...labels.map((option, index) => `${index + 1}. ${option}`),
      "Enter one or more numbers separated by commas:",
      "> ",
    ].join("\n"));
    const indexes = answer.split(",").map((value) => Number.parseInt(value.trim(), 10) - 1);
    const selected = selectedOptions(options, indexes);
    if (selected !== null) return selected;
    prompt.write(`Choose one or more numbers from 1 to ${options.length}.\n`);
  }
};

import { createLocalDemoHandler } from "./local-demo";

const localDemo = createLocalDemoHandler();

export default {
  fetch: async (request, bindings, executionContext): Promise<Response> =>
    (await localDemo).fetch(request, bindings, executionContext),
} satisfies ExportedHandler<Env>;

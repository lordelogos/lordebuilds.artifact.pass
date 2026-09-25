export const onRequest = (context) =>
  context.env.ARTIFACT_APPLICATION.fetch(context.request);

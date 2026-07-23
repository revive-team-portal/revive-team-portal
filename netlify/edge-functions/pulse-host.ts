// Serves the Pulse customer form for the pulse.* hostname only.
// team.revive.co.nz and all portal apps pass straight through untouched.
export default async (request: Request, context: any) => {
  try {
    const host = (request.headers.get("host") || "").toLowerCase();
    if (host.startsWith("pulse.")) {
      return await context.rewrite("/pulse-form/index.html");
    }
  } catch (_) { /* never block the portal */ }
  return context.next();
};
// Only run on root-level paths; exclude every portal app + functions so daily
// portal use never touches this function.
export const config = {
  path: "/*",
  excludedPath: [
    "/sales/*", "/support/*", "/recipes/*", "/rostering/*", "/production/*",
    "/pulse/*", "/pulse-form/*", "/.netlify/*", "/assets/*"
  ],
};

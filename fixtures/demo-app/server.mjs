import { createDemoServer } from "./app.mjs";

const port = Number(process.env.PORT ?? 3000);
createDemoServer({ seeded: process.env.TESTSWARM_SEEDED_DEFECTS === "1" }).listen(port, "127.0.0.1", () => console.log(`Demo app: http://127.0.0.1:${port}`));

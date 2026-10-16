import http from "node:http";
const seeded = process.env.TESTSWARM_SEEDED_DEFECTS === "1";
const pages = {
  "/": `<!doctype html><html><head><title>Demo shop</title></head><body><h1>Demo shop</h1><p>Controlled TestSwarm fixture.</p><nav><a href="/products">Products</a>${seeded ? '<a href="/seeded/missing-heading">Seeded defect</a>' : ''}</nav><form><label for="email">Email</label><input id="email" type="email"><button>Subscribe</button></form></body></html>`,
  "/products": '<!doctype html><html><head><title>Products</title></head><body><h1>Products</h1><a href="/">Home</a><button>Add to cart</button></body></html>',
  "/seeded/missing-heading": '<!doctype html><html><head><title>Broken seeded page</title></head><body><p>This route intentionally lacks a heading.</p></body></html>'
};
const port = Number(process.env.PORT ?? 3000);
http.createServer((req, res) => { const body = pages[req.url] ?? '<h1>Not found</h1>'; res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }); res.end(body); }).listen(port, "127.0.0.1", () => console.log(`Demo app: http://127.0.0.1:${port}`));

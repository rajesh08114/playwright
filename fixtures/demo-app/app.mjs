import http from "node:http";

const layout = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;max-width:100%}nav a{margin-right:12px}</style></head><body><main>${body}</main></body></html>`;

/** Pages of the controlled demo target. With seeded=true, three routes carry known, deliberate defects. */
export function demoPages(seeded = false) {
  const seededLinks = seeded ? '<a href="/seeded/missing-heading">Missing heading</a><a href="/seeded/unlabelled-input">Unlabelled input</a><a href="/seeded/overflow">Overflow</a>' : "";
  return {
    "/": layout("Demo shop", `<h1>Demo shop</h1><p>Controlled TestSwarm fixture.</p><nav aria-label="Primary"><a href="/products">Products</a>${seededLinks}</nav><form><label for="email">Email</label><input id="email" type="email"><button type="button">Subscribe</button></form>`),
    "/products": layout("Products", '<h1>Products</h1><nav aria-label="Primary"><a href="/">Home</a></nav><button type="button">Add to cart</button>'),
    ...(seeded ? {
      "/seeded/missing-heading": layout("Broken seeded page", "<p>This route intentionally lacks a heading.</p>"),
      "/seeded/unlabelled-input": layout("Unlabelled input", '<h1>Newsletter</h1><input type="text"><button type="button"></button>'),
      "/seeded/overflow": layout("Overflow", '<h1>Wide content</h1><div style="width:1600px;height:20px;background:#ccc"></div>')
    } : {})
  };
}

export function createDemoServer({ seeded = false } = {}) {
  const pages = demoPages(seeded);
  return http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const body = pages[path];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body ?? layout("Not found", "<h1>Not found</h1>"));
  });
}

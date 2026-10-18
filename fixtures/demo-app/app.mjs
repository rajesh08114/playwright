import http from "node:http";

const layout = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;max-width:100%}nav a{margin-right:12px}</style></head><body><main>${body}</main></body></html>`;
const escape = value => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const nav = extra => `<nav aria-label="Primary"><a href="/">Home</a><a href="/products">Products</a><a href="/search">Search</a><a href="/login">Sign in</a>${extra}</nav>`;

/** Demo credentials for the scripted-login fixture. */
export const DEMO_USER = { email: "demo@example.com", password: "demo-pass" };
const PRODUCTS = ["Blue mug", "Green mug", "Red teapot"];

/** Pages of the controlled demo target. With seeded=true, three routes carry known, deliberate defects. */
export function demoPages(seeded = false) {
  const seededLinks = seeded ? '<a href="/seeded/missing-heading">Missing heading</a><a href="/seeded/unlabelled-input">Unlabelled input</a><a href="/seeded/overflow">Overflow</a>' : "";
  return {
    "/": layout("Demo shop", `<h1>Demo shop</h1><p>Controlled TestSwarm fixture.</p>${nav(seededLinks)}<form><label for="email">Email</label><input id="email" type="email"><button type="button">Subscribe</button></form>`),
    "/products": layout("Products", `<h1>Products</h1>${nav("")}<ul>${PRODUCTS.map(name => `<li>${name}</li>`).join("")}</ul><button type="button" id="add">Add to cart</button><p>Cart: <span data-testid="cart-count" aria-live="polite">0</span> item(s)</p><script>document.getElementById("add").addEventListener("click",()=>{const c=document.querySelector("[data-testid=cart-count]");c.textContent=String(Number(c.textContent)+1);});</script>`),
    "/login": layout("Sign in", `<h1>Sign in</h1>${nav("")}<form method="post" action="/login"><label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="username"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`),
    ...(seeded ? {
      "/seeded/missing-heading": layout("Broken seeded page", "<p>This route intentionally lacks a heading.</p>"),
      "/seeded/unlabelled-input": layout("Unlabelled input", '<h1>Newsletter</h1><input type="text"><button type="button"></button>'),
      "/seeded/overflow": layout("Overflow", '<h1>Wide content</h1><div style="width:1600px;height:20px;background:#ccc"></div>')
    } : {})
  };
}

function searchPage(query) {
  const results = query ? PRODUCTS.filter(name => name.toLowerCase().includes(query.toLowerCase())) : [];
  return layout("Search", `<h1>Search</h1>${nav("")}<form method="get" action="/search" role="search"><label for="q">Search products</label><input id="q" name="q" value="${escape(query)}"><button type="submit">Search</button></form>${query ? `<h2>Results for ${escape(query)}</h2><ul>${results.map(name => `<li>${name}</li>`).join("") || "<li>No products found</li>"}</ul>` : ""}`);
}

export function createDemoServer({ seeded = false } = {}) {
  const pages = demoPages(seeded);
  const sessions = new Set();
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status, body, headers = {}) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); response.end(body); };
    const session = /(?:^|;\s*)session=([a-z0-9]+)/.exec(request.headers.cookie ?? "")?.[1];
    if (url.pathname === "/login" && request.method === "POST") {
      let body = "";
      request.on("data", chunk => { body += chunk; if (body.length > 10_000) request.destroy(); });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("email") === DEMO_USER.email && form.get("password") === DEMO_USER.password) {
          const id = Math.random().toString(36).slice(2);
          sessions.add(id);
          send(303, "", { location: "/account", "set-cookie": `session=${id}; HttpOnly; Path=/; SameSite=Lax` });
        } else send(401, layout("Sign in failed", `<h1>Sign in failed</h1>${nav("")}<p role="alert">Invalid email or password.</p>`));
      });
      return;
    }
    if (url.pathname === "/account") return session && sessions.has(session) ? send(200, layout("Your account", `<h1>Your account</h1>${nav("")}<p>Signed in as ${DEMO_USER.email}.</p>`)) : send(303, "", { location: "/login" });
    if (url.pathname === "/search") return send(200, searchPage(url.searchParams.get("q") ?? ""));
    const body = pages[url.pathname];
    send(body ? 200 : 404, body ?? layout("Not found", "<h1>Not found</h1>"));
  });
}

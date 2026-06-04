const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SEED_DB_FILE = path.join(ROOT, "data", "links.json");
const DATA_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "consent-link-tracker") : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "links.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    try {
      await fs.copyFile(SEED_DB_FILE, DB_FILE);
    } catch {
      await fs.writeFile(DB_FILE, JSON.stringify({ links: [], clicks: [] }, null, 2));
    }
  }
}

async function readDb() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(["GET", "tracker_db"])
      });
      if (!response.ok) {
        console.error("KV Read API Error:", await response.text());
      } else {
        const data = await response.json();
        if (data && data.result) {
          return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        }
      }
    } catch (e) {
      console.error("KV Read Error", e);
    }
    return { links: [], clicks: [] };
  }

  await ensureDb();
  return JSON.parse(await fs.readFile(DB_FILE, "utf8"));
}

async function writeDb(db) {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const response = await fetch(process.env.KV_REST_API_URL, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(["SET", "tracker_db", JSON.stringify(db)])
      });
      if (!response.ok) {
        console.error("KV Write API Error:", await response.text());
      }
    } catch (e) {
      console.error("KV Write Error", e);
    }
    return;
  }

  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
  });
}

function cleanUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clientMeta(req) {
  return {
    userAgent: req.headers["user-agent"] || "Unknown",
    acceptLanguage: req.headers["accept-language"] || "Unknown",
    referrer: req.headers.referer || "",
    // Do not store IP addresses. This app is intentionally consent-forward.
    ipAddressStored: false
  };
}

function publicLink(baseUrl, link) {
  return {
    ...link,
    trackingUrl: `${baseUrl}/open.html?id=${link.id}`
  };
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const filePath = requestPath === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, requestPath);
  const safePath = path.normalize(filePath);

  if (!safePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(safePath);
    const ext = path.extname(safePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  } catch {
    sendError(res, 404, "Not found");
  }
}

async function handleApi(req, res, url) {
  const baseUrl = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
  const db = await readDb();

  if (req.method === "GET" && url.pathname === "/api/links") {
    const clicksByLink = db.clicks.reduce((acc, click) => {
      acc[click.linkId] = (acc[click.linkId] || 0) + 1;
      return acc;
    }, {});
    sendJson(res, 200, {
      links: db.links
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((link) => ({
          ...publicLink(baseUrl, link),
          clickCount: clicksByLink[link.id] || 0
        }))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/links") {
    const body = await parseBody(req);
    const destinationUrl = cleanUrl(body.destinationUrl);
    if (!destinationUrl) {
      sendError(res, 400, "Enter a valid http or https destination URL.");
      return;
    }

    const link = {
      id: crypto.randomBytes(5).toString("base64url"),
      title: String(body.title || "Untitled link").trim().slice(0, 80) || "Untitled link",
      destinationUrl,
      disclosure: String(body.disclosure || "").trim().slice(0, 220),
      createdAt: new Date().toISOString()
    };

    db.links.push(link);
    await writeDb(db);
    sendJson(res, 201, { link: publicLink(baseUrl, link) });
    return;
  }

  const clickMatch = url.pathname.match(/^\/api\/links\/([^/]+)\/clicks$/);
  if (req.method === "GET" && clickMatch) {
    const linkId = clickMatch[1];
    const link = db.links.find((item) => item.id === linkId);
    if (!link) {
      sendError(res, 404, "Link not found");
      return;
    }

    sendJson(res, 200, {
      link: publicLink(baseUrl, link),
      clicks: db.clicks
        .filter((click) => click.linkId === linkId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    });
    return;
  }

  const openMatch = url.pathname.match(/^\/api\/visits\/([^/]+)$/);
  if (req.method === "POST" && openMatch) {
    const linkId = openMatch[1];
    const link = db.links.find((item) => item.id === linkId);
    if (!link) {
      sendError(res, 404, "Link not found");
      return;
    }

    const body = await parseBody(req);
    const click = {
      id: crypto.randomBytes(8).toString("base64url"),
      linkId,
      createdAt: new Date().toISOString(),
      timezone: String(body.timezone || "Unknown").slice(0, 80),
      screen: String(body.screen || "Unknown").slice(0, 80),
      locationPermission: "not_requested",
      preciseLocation: null,
      ...clientMeta(req)
    };

    db.clicks.push(click);
    await writeDb(db);
    sendJson(res, 201, { clickId: click.id, destinationUrl: link.destinationUrl });
    return;
  }

  const locationMatch = url.pathname.match(/^\/api\/clicks\/([^/]+)\/location$/);
  if (req.method === "PATCH" && locationMatch) {
    const click = db.clicks.find((item) => item.id === locationMatch[1]);
    if (!click) {
      sendError(res, 404, "Click not found");
      return;
    }

    const body = await parseBody(req);
    click.locationPermission = body.permission === "granted" ? "granted" : "declined";
    click.preciseLocation = null;

    if (click.locationPermission === "granted") {
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      const accuracyMeters = Number(body.accuracyMeters);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        sendError(res, 400, "Invalid GPS coordinates.");
        return;
      }

      click.preciseLocation = {
        latitude,
        longitude,
        accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : null,
        sharedAt: new Date().toISOString()
      };
    }

    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, "API route not found");
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname === "/visit.html" || url.pathname.startsWith("/go/")) {
      await serveStatic({ ...req, url: "/open.html" }, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendError(res, 500, error.message || "Server error");
  }
}

module.exports = handleRequest;

if (require.main === module) {
  ensureDb()
    .then(() => {
      http.createServer(handleRequest).listen(PORT, () => {
        console.log(`Consent Link Tracker is running at http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIRECTORY = path.resolve(__dirname, "data");
const DATABASE_PATH = path.resolve(
    process.env.KHATA_DB_PATH || path.join(DATA_DIRECTORY, "khata.sqlite")
);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
const COLLECTIONS = ["customers", "transactions", "products", "sales", "settings"];
const STATIC_FILES = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/script.js": ["script.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
};

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port.");
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS khata_data (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        collection TEXT NOT NULL,
        records TEXT NOT NULL,
        PRIMARY KEY (user_id, collection)
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );
`);

function sendJson(response, status, payload) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(payload));
}

function apiError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function getCookies(request) {
    const cookies = {};
    for (const part of (request.headers.cookie || "").split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0) {
            cookies[part.slice(0, separator).trim()] =
                part.slice(separator + 1).trim();
        }
    }
    return cookies;
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function getSession(request) {
    const token = getCookies(request).khata_session;
    if (!token) return null;

    const session = database.prepare(`
        SELECT sessions.user_id AS userId, sessions.csrf_token AS csrfToken,
               users.username AS username, sessions.expires_at AS expiresAt
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
    `).get(hashToken(token));

    if (!session) return null;
    if (session.expiresAt <= Math.floor(Date.now() / 1000)) {
        database.prepare("DELETE FROM sessions WHERE token_hash = ?")
            .run(hashToken(token));
        return null;
    }

    return session;
}

function requireCsrf(request, session) {
    const supplied = request.headers["x-csrf-token"];
    if (typeof supplied !== "string") {
        throw apiError(403, "Your session token is invalid. Please sign in again.");
    }
    const expectedBuffer = Buffer.from(session.csrfToken);
    const suppliedBuffer = Buffer.from(supplied);
    if (expectedBuffer.length !== suppliedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        throw apiError(403, "Your session token is invalid. Please sign in again.");
    }
}

async function readJson(request) {
    if (!String(request.headers["content-type"] || "")
        .toLowerCase().startsWith("application/json")) {
        throw apiError(415, "This request must use JSON.");
    }

    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > MAX_BODY_BYTES) {
        throw apiError(413, "Request is too large.");
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
            throw apiError(413, "Request is too large.");
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw apiError(400, "The request body is not valid JSON.");
    }
}

function validateCredentials(body) {
    if (!body || typeof body.username !== "string" ||
        !/^[A-Za-z0-9._-]{3,32}$/.test(body.username)) {
        throw apiError(400, "Username 3-32 characters ka ho; letters, numbers, dot, underscore ya hyphen use karein.");
    }
    if (typeof body.password !== "string" ||
        Buffer.byteLength(body.password, "utf8") < 8 ||
        Buffer.byteLength(body.password, "utf8") > 128) {
        throw apiError(400, "Password 8-128 bytes ka hona chahiye.");
    }
}

function validateSettingsRecords(records) {
    if (records.length !== 1) {
        throw apiError(400, "Business settings must contain one profile.");
    }

    const settings = records[0];
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        typeof settings.businessName !== "string" ||
        !settings.businessName.trim() || settings.businessName.trim().length > 80 ||
        typeof settings.ownerName !== "string" || settings.ownerName.length > 80 ||
        typeof settings.logoDataUrl !== "string" ||
        settings.logoDataUrl.length > 450000 ||
        (settings.logoDataUrl &&
            !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(settings.logoDataUrl))) {
        throw apiError(400, "Business settings are invalid.");
    }
}

async function createPasswordHash(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64);
    return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const [saltHex, keyHex] = storedHash.split(":");
    if (!/^[a-f0-9]{32}$/i.test(saltHex || "") ||
        !/^[a-f0-9]{128}$/i.test(keyHex || "")) {
        throw new Error("Stored password hash is invalid.");
    }
    const expected = Buffer.from(keyHex, "hex");
    const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

function getAccountData(userId) {
    const rows = database.prepare(
        "SELECT collection, records FROM khata_data WHERE user_id = ?"
    ).all(userId);
    const data = Object.fromEntries(COLLECTIONS.map(collection => [collection, []]));
    for (const row of rows) {
        data[row.collection] = JSON.parse(row.records);
    }
    return data;
}

function startSession(response, user) {
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;

    database.prepare(`
        INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
        VALUES (?, ?, ?, ?)
    `).run(hashToken(token), user.id, csrfToken, expiresAt);

    response.setHeader(
        "Set-Cookie",
        `khata_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`
    );
    return {
        user: { username: user.username },
        data: getAccountData(user.id),
        csrfToken
    };
}

async function handleAuth(action, request, response) {
    const body = await readJson(request);
    validateCredentials(body);
    const username = body.username.trim();

    if (action === "register") {
        const passwordHash = await createPasswordHash(body.password);
        let result;
        try {
            result = database.prepare(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)"
            ).run(username, passwordHash);
        } catch (error) {
            if (String(error.message).includes("UNIQUE")) {
                throw apiError(409, "That username is already taken.");
            }
            throw error;
        }
        sendJson(response, 201, startSession(response, {
            id: Number(result.lastInsertRowid),
            username
        }));
        return;
    }

    const user = database.prepare(
        "SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?"
    ).get(username);

    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
        throw apiError(401, "Incorrect username or password.");
    }

    sendJson(response, 200, startSession(response, user));
}

async function handleApi(request, response, url) {
    const action = url.searchParams.get("action");
    if (!action) throw apiError(400, "An API action is required.");

    if (action === "register" || action === "login") {
        if (request.method !== "POST") {
            throw apiError(405, "This method is not allowed.");
        }
        await handleAuth(action, request, response);
        return;
    }

    if (action === "me" || action === "data") {
        if (request.method !== "GET" && !(action === "data" && request.method === "POST")) {
            throw apiError(405, "This method is not allowed.");
        }
        const session = getSession(request);
        if (!session) throw apiError(401, "Please sign in to continue.");
        if (request.method === "GET") {
            sendJson(response, 200, {
                user: { username: session.username },
                data: getAccountData(session.userId),
                csrfToken: session.csrfToken
            });
            return;
        }

        requireCsrf(request, session);
        const body = await readJson(request);
        if (!body || !COLLECTIONS.includes(body.collection) ||
            !Array.isArray(body.records)) {
            throw apiError(400, "The data collection is invalid.");
        }
        if (body.collection === "settings") {
            validateSettingsRecords(body.records);
        }
        database.prepare(`
            INSERT INTO khata_data (user_id, collection, records)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, collection)
            DO UPDATE SET records = excluded.records
        `).run(session.userId, body.collection, JSON.stringify(body.records));
        sendJson(response, 200, { success: true });
        return;
    }

    if (action === "logout") {
        if (request.method !== "POST") {
            throw apiError(405, "This method is not allowed.");
        }
        const session = getSession(request);
        if (!session) throw apiError(401, "Please sign in to continue.");
        requireCsrf(request, session);
        database.prepare("DELETE FROM sessions WHERE token_hash = ?")
            .run(hashToken(getCookies(request).khata_session));
        response.setHeader(
            "Set-Cookie",
            "khata_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        );
        sendJson(response, 200, { success: true });
        return;
    }

    throw apiError(404, "Unknown API action.");
}

async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api") {
        await handleApi(request, response, url);
        return;
    }

    const staticFile = STATIC_FILES[url.pathname];
    if (!staticFile || request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
    }

    const [fileName, contentType] = staticFile;
    const contents = fs.readFileSync(path.join(__dirname, fileName));
    response.writeHead(200, {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache"
    });
    response.end(request.method === "HEAD" ? undefined : contents);
}

const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
        if (response.headersSent) {
            response.destroy(error);
            return;
        }
        if (error.status >= 500 || !error.status) {
            console.error("Request failed:", error);
        }
        sendJson(response, error.status || 500, {
            error: error.status ? error.message : "The server could not complete this request."
        });
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Digital Khata running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${DATABASE_PATH}`);
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === "IPv4" && !address.internal) {
                console.log(`Mobile (same Wi-Fi): http://${address.address}:${PORT}`);
            }
        }
    }
});

function shutDown() {
    server.close(() => {
        database.close();
        process.exit(0);
    });
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);

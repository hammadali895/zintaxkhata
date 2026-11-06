const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { createClient } = require("@supabase/supabase-js");

const scrypt = promisify(crypto.scrypt);
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const COLLECTIONS = ["customers", "transactions", "products", "sales"];

let supabase;

function getSupabase() {
    if (supabase) return supabase;
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
        const error = new Error("The backend is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.");
        error.status = 503;
        throw error;
    }
    supabase = createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
    return supabase;
}

function apiError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function sendJson(response, status, payload) {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.status(status).json(payload);
}

function getCookies(request) {
    const header = request.headers.cookie;
    const cookies = {};
    for (const part of (Array.isArray(header) ? header.join(";") : header || "").split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0) cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
    return cookies;
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function readJson(request) {
    if (Number(request.headers["content-length"] || 0) > MAX_BODY_BYTES) throw apiError(413, "Request is too large.");
    if (request.body !== undefined) {
        if (typeof request.body === "object" && request.body !== null) return request.body;
        try { return JSON.parse(request.body); } catch { throw apiError(400, "The request body is not valid JSON."); }
    }
    let raw = "";
    for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw apiError(413, "Request is too large.");
    }
    try { return JSON.parse(raw); } catch { throw apiError(400, "The request body is not valid JSON."); }
}

function validateCredentials(body) {
    if (!body || typeof body.username !== "string" || !/^[A-Za-z0-9._-]{3,32}$/.test(body.username)) {
        throw apiError(400, "Username 3-32 characters ka ho; letters, numbers, dot, underscore ya hyphen use karein.");
    }
    if (typeof body.password !== "string" || Buffer.byteLength(body.password, "utf8") < 8 || Buffer.byteLength(body.password, "utf8") > 128) {
        throw apiError(400, "Password 8-128 bytes ka hona chahiye.");
    }
}

async function createPasswordHash(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64);
    return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const [saltHex, keyHex] = storedHash.split(":");
    if (!/^[a-f0-9]{32}$/i.test(saltHex || "") || !/^[a-f0-9]{128}$/i.test(keyHex || "")) throw new Error("Stored password hash is invalid.");
    const expected = Buffer.from(keyHex, "hex");
    const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

async function getAccountData(client, userId) {
    const { data: rows, error } = await client.from("khata_data").select("collection, records").eq("user_id", userId);
    if (error) throw error;
    const result = Object.fromEntries(COLLECTIONS.map(collection => [collection, []]));
    for (const row of rows) {
        if (!COLLECTIONS.includes(row.collection) || !Array.isArray(row.records)) throw new Error("Stored account data is invalid.");
        result[row.collection] = row.records;
    }
    return result;
}

async function getSession(client, request) {
    const token = getCookies(request).khata_session;
    if (!token) return null;
    const tokenHash = hashToken(token);
    const { data: session, error } = await client.from("khata_sessions").select("user_id, csrf_token, expires_at").eq("token_hash", tokenHash).maybeSingle();
    if (error) throw error;
    if (!session) return null;
    if (Date.parse(session.expires_at) <= Date.now()) {
        const { error: deleteError } = await client.from("khata_sessions").delete().eq("token_hash", tokenHash);
        if (deleteError) throw deleteError;
        return null;
    }
    const { data: user, error: userError } = await client.from("khata_users").select("username").eq("id", session.user_id).single();
    if (userError) throw userError;
    return { tokenHash, userId: session.user_id, csrfToken: session.csrf_token, username: user.username };
}

function requireCsrf(request, session) {
    const supplied = request.headers["x-csrf-token"];
    if (typeof supplied !== "string") throw apiError(403, "Your session token is invalid. Please sign in again.");
    const expected = Buffer.from(session.csrfToken);
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw apiError(403, "Your session token is invalid. Please sign in again.");
}

function setSessionCookie(response, token, maxAge) {
    const secure = process.env.VERCEL === "1" ? "; Secure" : "";
    response.setHeader("Set-Cookie", `khata_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

async function startSession(client, response, user) {
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
    const { error } = await client.from("khata_sessions").insert({ token_hash: hashToken(token), user_id: user.id, csrf_token: csrfToken, expires_at: expiresAt });
    if (error) throw error;
    setSessionCookie(response, token, SESSION_DURATION_SECONDS);
    return { user: { username: user.username }, data: await getAccountData(client, user.id), csrfToken };
}

async function handleAuth(client, action, request, response) {
    const body = await readJson(request);
    validateCredentials(body);
    const username = body.username.trim().toLowerCase();
    if (action === "register") {
        const passwordHash = await createPasswordHash(body.password);
        const { data: user, error } = await client.from("khata_users").insert({ username, password_hash: passwordHash }).select("id, username").single();
        if (error?.code === "23505") throw apiError(409, "That username is already taken.");
        if (error) throw error;
        sendJson(response, 201, await startSession(client, response, user));
        return;
    }
    const { data: user, error } = await client.from("khata_users").select("id, username, password_hash").eq("username", username).maybeSingle();
    if (error) throw error;
    if (!user || !(await verifyPassword(body.password, user.password_hash))) throw apiError(401, "Incorrect username or password.");
    sendJson(response, 200, await startSession(client, response, user));
}

async function handleApi(client, request, response, action) {
    if (action === "register" || action === "login") {
        if (request.method !== "POST") throw apiError(405, "This method is not allowed.");
        await handleAuth(client, action, request, response);
        return;
    }
    if (action === "me" || action === "data") {
        if (request.method !== "GET" && !(action === "data" && request.method === "POST")) throw apiError(405, "This method is not allowed.");
        const session = await getSession(client, request);
        if (!session) throw apiError(401, "Please sign in to continue.");
        if (request.method === "GET") {
            sendJson(response, 200, { user: { username: session.username }, data: await getAccountData(client, session.userId), csrfToken: session.csrfToken });
            return;
        }
        requireCsrf(request, session);
        const body = await readJson(request);
        if (!body || !COLLECTIONS.includes(body.collection) || !Array.isArray(body.records)) throw apiError(400, "The data collection is invalid.");
        const { error } = await client.from("khata_data").upsert({ user_id: session.userId, collection: body.collection, records: body.records }, { onConflict: "user_id,collection" });
        if (error) throw error;
        sendJson(response, 200, { success: true });
        return;
    }
    if (action === "logout") {
        if (request.method !== "POST") throw apiError(405, "This method is not allowed.");
        const session = await getSession(client, request);
        if (!session) throw apiError(401, "Please sign in to continue.");
        requireCsrf(request, session);
        const { error } = await client.from("khata_sessions").delete().eq("token_hash", session.tokenHash);
        if (error) throw error;
        setSessionCookie(response, "", 0);
        sendJson(response, 200, { success: true });
        return;
    }
    throw apiError(404, "Unknown API action.");
}

module.exports = async function handler(request, response) {
    try {
        if (!["GET", "POST"].includes(request.method)) throw apiError(405, "This method is not allowed.");
        const url = new URL(request.url, "https://vercel.local");
        const action = url.searchParams.get("action") || (Array.isArray(request.query?.action) ? request.query.action[0] : request.query?.action);
        if (!action) throw apiError(400, "An API action is required.");
        await handleApi(getSupabase(), request, response, action);
    } catch (error) {
        if (response.headersSent) { response.end(); return; }
        if (!error.status || error.status >= 500) console.error("API request failed:", error);
        sendJson(response, error.status || 500, { error: error.status ? error.message : "The server could not complete this request." });
    }
};

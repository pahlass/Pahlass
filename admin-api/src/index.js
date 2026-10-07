// Pahlass Admin Panel — API (Cloudflare Worker + D1)
// Rutas:
//   POST   /api/login          { password }              -> set-cookie de sesión
//   POST   /api/logout                                    -> borra la sesión
//   GET    /api/me                                         -> valida la sesión actual
//   GET    /api/projects                                   -> lista de proyectos
//   POST   /api/projects       { name, client, ... }       -> crea proyecto
//   PATCH  /api/projects/:id   { campos a actualizar }      -> actualiza proyecto
//   DELETE /api/projects/:id                                -> elimina proyecto

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 horas
const COOKIE_NAME = "pahlass_session";
const VALID_STATUS = ["Solicitud", "Evaluación", "Desarrollo", "Entrega", "Completado"];
const VALID_PRIORITY = ["Baja", "Normal", "Alta"];

function corsHeaders(origin, allowedOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
  if (origin === allowedOrigin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

function bufToBase64Url(buf) {
  let str = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuf(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const str = atob(b64 + pad);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes.buffer;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSession(secret) {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
  const payloadB64 = bufToBase64Url(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${bufToBase64Url(sig)}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [payloadB64, sigB64] = token.split(".");
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBuf(sigB64),
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBuf(payloadB64)));
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

async function requireAuth(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  return verifySession(token, env.SESSION_SECRET);
}

function sessionCookie(value, maxAge) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}

// Si el proyecto tiene subtareas, su avance se calcula solo (subtareas hechas / total).
async function syncProjectProgress(env, projectId) {
  const { results } = await env.DB.prepare(
    "SELECT done FROM tasks WHERE project_id = ?"
  )
    .bind(projectId)
    .all();
  if (results.length === 0) return;
  const done = results.filter((t) => t.done).length;
  const progress = Math.round((done / results.length) * 100);
  await env.DB.prepare("UPDATE projects SET progress = ?, updated_at = ? WHERE id = ?")
    .bind(progress, new Date().toISOString(), projectId)
    .run();
}

const REQUEST_TO_EMAIL = "anthoniomoreno1@gmail.com";

async function sendRequestEmail(env, data) {
  const subject = `Solicitud de sesión — ${data.organizacion} (${data.folio})`;
  const text =
    `Folio: ${data.folio}\n` +
    `Nombre: ${data.nombre}\n` +
    `Organización: ${data.organizacion}\n` +
    `Correo de contacto: ${data.correo}\n` +
    `Industria: ${data.industria || "—"}\n\n` +
    `¿Qué le gustaría resolver?\n${data.mensaje || "—"}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Pahlass <onboarding@resend.dev>",
      to: [REQUEST_TO_EMAIL],
      reply_to: data.correo,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${errBody}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ---- auth ----
      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!constantTimeEqual(body.password || "", env.ADMIN_PASSWORD)) {
          return json({ ok: false, error: "Contraseña incorrecta." }, 401, cors);
        }
        const token = await signSession(env.SESSION_SECRET);
        return json({ ok: true }, 200, {
          ...cors,
          "Set-Cookie": sessionCookie(token, SESSION_TTL_SECONDS),
        });
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        return json({ ok: true }, 200, { ...cors, "Set-Cookie": sessionCookie("", 0) });
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        const authed = await requireAuth(request, env);
        return json({ ok: authed }, authed ? 200 : 401, cors);
      }

      // ---- solicitud pública desde el panel "Iniciar un proyecto" del sitio ----
      if (url.pathname === "/api/solicitudes" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const nombre = (body.nombre || "").trim();
        const organizacion = (body.organizacion || "").trim();
        const correo = (body.correo || "").trim();
        const industria = (body.industria || "").trim();
        const mensaje = (body.mensaje || "").trim();
        const correoOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
        if (!nombre || !organizacion || !correoOk) {
          return json({ ok: false, error: "Revisa los campos del formulario." }, 400, cors);
        }
        const folio = "PAHLASS-" + new Date().getFullYear() + "-" + String(Math.floor(1000 + Math.random() * 9000));
        try {
          await sendRequestEmail(env, { nombre, organizacion, correo, industria, mensaje, folio });
        } catch (err) {
          return json({ ok: false, error: "No se pudo enviar la solicitud. Intenta de nuevo." }, 502, cors);
        }
        return json({ ok: true, folio }, 200, cors);
      }

      // ---- todo lo demás requiere sesión válida ----
      if (!(await requireAuth(request, env))) {
        return json({ ok: false, error: "No autorizado." }, 401, cors);
      }

      // ---- proyectos ----
      if (url.pathname === "/api/projects" && request.method === "GET") {
        const [{ results: projects }, { results: tasks }] = await Promise.all([
          env.DB.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all(),
          env.DB.prepare("SELECT * FROM tasks ORDER BY position ASC, id ASC").all(),
        ]);
        const tasksByProject = {};
        for (const t of tasks) {
          (tasksByProject[t.project_id] ||= []).push({ ...t, done: !!t.done });
        }
        for (const p of projects) p.tasks = tasksByProject[p.id] || [];
        return json({ ok: true, projects }, 200, cors);
      }

      if (url.pathname === "/api/projects" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body.name || !body.name.trim()) {
          return json({ ok: false, error: "El nombre del proyecto es obligatorio." }, 400, cors);
        }
        const status = VALID_STATUS.includes(body.status) ? body.status : "Solicitud";
        const priority = VALID_PRIORITY.includes(body.priority) ? body.priority : "Normal";
        const progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
        const ref = "PAHLASS-" + Date.now().toString(36).toUpperCase();
        const now = new Date().toISOString();
        const dueDate = typeof body.due_date === "string" && body.due_date ? body.due_date : null;
        await env.DB.prepare(
          `INSERT INTO projects (ref, name, client, status, priority, progress, description, due_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(ref, body.name.trim(), body.client || "", status, priority, progress, body.description || "", dueDate, now, now)
          .run();
        return json({ ok: true, ref }, 201, cors);
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
      if (projectMatch && request.method === "PATCH") {
        const id = Number(projectMatch[1]);
        const body = await request.json().catch(() => ({}));
        const fields = [];
        const values = [];
        if (typeof body.name === "string") { fields.push("name = ?"); values.push(body.name.trim()); }
        if (typeof body.client === "string") { fields.push("client = ?"); values.push(body.client); }
        if (VALID_STATUS.includes(body.status)) { fields.push("status = ?"); values.push(body.status); }
        if (VALID_PRIORITY.includes(body.priority)) { fields.push("priority = ?"); values.push(body.priority); }
        if (body.progress !== undefined) {
          // El avance solo se puede fijar a mano si el proyecto no tiene subtareas;
          // si las tiene, se calcula solo a partir de ellas (ver syncProjectProgress).
          const { results: existingTasks } = await env.DB.prepare(
            "SELECT id FROM tasks WHERE project_id = ? LIMIT 1"
          )
            .bind(id)
            .all();
          if (existingTasks.length === 0) {
            fields.push("progress = ?");
            values.push(Math.max(0, Math.min(100, Number(body.progress) || 0)));
          }
        }
        if (typeof body.description === "string") { fields.push("description = ?"); values.push(body.description); }
        if (typeof body.report === "string") { fields.push("report = ?"); values.push(body.report); }
        if (body.due_date !== undefined) { fields.push("due_date = ?"); values.push(body.due_date || null); }
        if (fields.length === 0) {
          return json({ ok: false, error: "Nada para actualizar." }, 400, cors);
        }
        fields.push("updated_at = ?");
        values.push(new Date().toISOString());
        values.push(id);
        await env.DB.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`)
          .bind(...values)
          .run();
        return json({ ok: true }, 200, cors);
      }

      if (projectMatch && request.method === "DELETE") {
        const id = Number(projectMatch[1]);
        await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
        return json({ ok: true }, 200, cors);
      }

      // ---- subtareas ----
      const tasksListMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/tasks$/);
      if (tasksListMatch && request.method === "POST") {
        const projectId = Number(tasksListMatch[1]);
        const body = await request.json().catch(() => ({}));
        if (!body.title || !body.title.trim()) {
          return json({ ok: false, error: "El título de la subtarea es obligatorio." }, 400, cors);
        }
        const { results } = await env.DB.prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS nextPos FROM tasks WHERE project_id = ?"
        )
          .bind(projectId)
          .all();
        const position = results[0]?.nextPos ?? 0;
        const res = await env.DB.prepare(
          "INSERT INTO tasks (project_id, title, position) VALUES (?, ?, ?)"
        )
          .bind(projectId, body.title.trim(), position)
          .run();
        await syncProjectProgress(env, projectId);
        return json({ ok: true, id: res.meta.last_row_id }, 201, cors);
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch && request.method === "PATCH") {
        const id = Number(taskMatch[1]);
        const body = await request.json().catch(() => ({}));
        const fields = [];
        const values = [];
        if (typeof body.title === "string") { fields.push("title = ?"); values.push(body.title.trim()); }
        if (body.done !== undefined) { fields.push("done = ?"); values.push(body.done ? 1 : 0); }
        if (typeof body.detail === "string") { fields.push("detail = ?"); values.push(body.detail); }
        if (fields.length === 0) {
          return json({ ok: false, error: "Nada para actualizar." }, 400, cors);
        }
        values.push(id);
        const taskRow = await env.DB.prepare("SELECT project_id FROM tasks WHERE id = ?").bind(id).first();
        await env.DB.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
          .bind(...values)
          .run();
        if (taskRow) await syncProjectProgress(env, taskRow.project_id);
        return json({ ok: true }, 200, cors);
      }

      if (taskMatch && request.method === "DELETE") {
        const id = Number(taskMatch[1]);
        const taskRow = await env.DB.prepare("SELECT project_id FROM tasks WHERE id = ?").bind(id).first();
        await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
        if (taskRow) await syncProjectProgress(env, taskRow.project_id);
        return json({ ok: true }, 200, cors);
      }

      return json({ ok: false, error: "No encontrado." }, 404, cors);
    } catch (err) {
      return json({ ok: false, error: "Error del servidor." }, 500, cors);
    }
  },
};

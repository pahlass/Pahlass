# Pahlass — repositorio del sitio

Código fuente de [pahlass.com](https://pahlass.com). Sitio estático (sin build step)
más un backend ligero en Cloudflare Workers para el panel de administración y el
formulario de contacto.

## Estructura

```
index.html              sitio público (una sola página, rutas por #hash)
assets/
  css/site.css           estilos del sitio público
  js/site.js              lógica del sitio público (ruteo, buscador, formulario, animaciones)
  img/                     fotografías y logos del sitio público
  videos/                  clips de fondo de la portada (con su .jpg de poster)
favicon-32.png, favicon-180.png
robots.txt, sitemap.xml
_headers                 cabeceras HTTP (seguridad + caché) — las lee Cloudflare Pages
_redirects                redirecciones de URLs antiguas — las lee Cloudflare Pages

admin/                   panel de control interno (gestión de proyectos)
admin-api/                API del panel y del formulario de contacto (Cloudflare Worker + D1)
emisor/                   editor interno de propuestas
uploads/                  carpeta de paso para subir imágenes nuevas desde GitHub

site/                     rediseño en Next.js — en desarrollo, todavía NO publicado
                          (ver site/README.md; no interfiere con nada de lo anterior)
```

`index.html` no tiene build step: es HTML servido tal cual, con CSS/JS propios en
`assets/`. `admin/` y `emisor/` son herramientas internas aparte, cada una
autocontenida (su propio HTML con estilos y script inline), sin dependencias de
`assets/`.

## Desarrollo local

No hace falta ningún instalador para el sitio público ni para `admin/`/`emisor/`:

```bash
python3 -m http.server 8080
# abrir http://localhost:8080/
```

Para trabajar en el backend (`admin-api/`), ver la sección más abajo.

## El sitio público (`index.html`)

Una sola página con ruteo por `location.hash` (`#plataforma`, `#productos`,
`#caso/<slug>`, `#prensa`, `#producto/<slug>`, `#contacto`, etc. — ver el mapa
completo en el pie de página del sitio). Todo el contenido de "casos" y
"productos" vive como datos dentro de `assets/js/site.js` y se renderiza con una
función `esc()` que escapa el HTML antes de insertarlo — no hay riesgo de XSS vía
el hash de la URL ni vía el buscador.

El formulario de `#contacto` envía la solicitud a la misma API que usa `admin/`
(`POST /api/solicitudes` en `admin-api`), que a su vez manda un correo con
[Resend]. No se guarda en base de datos — es solo transaccional.

## `admin-api` (Cloudflare Worker)

```
admin-api/
  src/index.js      todas las rutas de la API
  schema.sql         esquema inicial de la base D1
  migrations/         cambios posteriores al esquema
  wrangler.toml        config del Worker (nombre, binding de D1, ALLOWED_ORIGIN)
```

Rutas:

| Método | Ruta | Qué hace | Auth |
|---|---|---|---|
| POST | `/api/solicitudes` | recibe el formulario de contacto del sitio público, envía el correo | pública |
| POST | `/api/login`, `/api/logout`, GET `/api/me` | sesión del panel | — |
| GET/POST/PATCH/DELETE | `/api/projects...` | CRUD de proyectos del panel | requiere sesión |

**Variables de entorno que necesita** (se configuran en el dashboard de Cloudflare
o con `wrangler secret put <NOMBRE>` — nunca van en el repo):

- `SESSION_SECRET` — clave para firmar la cookie de sesión del panel admin.
- `RESEND_API_KEY` — para enviar el correo de cada solicitud de contacto.
- `ALLOWED_ORIGIN` (ya está en `wrangler.toml` como var pública) — origen permitido
  por CORS; debe ser `https://pahlass.com`.

Para desplegar cambios del Worker:

```bash
cd admin-api
npm install
npx wrangler deploy
```

## Seguridad

- **Cabeceras HTTP** (`_headers`, leído automáticamente por Cloudflare Pages):
  CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS, caché inmutable de un año para todo lo que cuelga
  de `/assets/`, y `X-Robots-Tag: noindex` en `/admin/` y `/emisor/` (son
  herramientas internas, no deben indexarse).
- **Sin claves ni secretos en el código.** El único backend con credenciales
  (`admin-api`) las lee de variables de entorno de Cloudflare, nunca del repo.
- **Sin inyección vía hash/buscador:** revisado — todo el contenido dinámico se
  escapa antes de insertarse en el DOM (ver `esc()` en `assets/js/site.js`).
- `robots.txt` bloquea el rastreo de `/admin/` y `/emisor/`.

## Rendimiento

- CSS y JS del sitio público viven en archivos propios (`assets/css/site.css`,
  `assets/js/site.js`) en vez de estar embebidos en el HTML, así el navegador los
  cachea aparte del documento.
- Los logos que antes iban como `base64` dentro del HTML (~130 KB extra en cada
  carga) ahora son archivos PNG normales y cacheables
  (`assets/img/pahlass-logo-dark.png`, `pahlass-logo-light.png`).
- Imágenes fuera de la primera pantalla usan `loading="lazy"`; todas usan
  `decoding="async"`.
- Los videos de fondo de la portada usan `preload="metadata"` salvo el primero
  (el que se ve de entrada), que mantiene `preload="auto"` para que arranque sin
  esperar.
- `_headers` fija caché de un año (`immutable`) para todo `/assets/*`.

## Despliegue

**Hoy:** GitHub Pages, usando el archivo `CNAME` en la raíz (dominio
`pahlass.com`) — se sirve lo que esté en la rama `main`.

**En proceso de migración a Cloudflare Pages.** Mientras ambos convivan, el
`CNAME` de GitHub Pages se queda; se retira cuando el DNS termine de apuntar a
Cloudflare. Los archivos `_headers` y `_redirects` ya están listos — Cloudflare
Pages los lee solos, no hace falta configurarlos a mano en el dashboard.

## Otras carpetas

- **`site/`** — rediseño del sitio público en Next.js 14 + TypeScript + Tailwind.
  Vive aparte a propósito (ver `site/README.md`) y **no está publicado todavía**;
  se corre solo en local para revisión de diseño.
- **`uploads/`** — carpeta de paso: subir ahí un archivo nuevo desde GitHub y
  luego moverlo a `assets/img/` o `assets/videos/` según corresponda.

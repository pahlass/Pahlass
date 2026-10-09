#!/usr/bin/env python3
"""Genera las páginas con URL propia que Google puede indexar por separado.

El sitio es una sola página (index.html) con vistas que se abren por ancla
(#acerca, #producto/coppermind, #caso/<slug>…). Google ignora lo que va
después de "#", así que para que cada vista tenga su propia URL en los
resultados de búsqueda este script copia index.html a:

  /acerca/  /prensa/  /coppermind/  /diagram/  /casos/<slug>/

cambiando solo el <head> (título, descripción, canonical y Open Graph).
Al cargar, assets/js/site.js abre la vista que corresponde a la ruta.
También regenera sitemap.xml.

Ejecútalo después de cualquier cambio en index.html o en los textos de
assets/js/site.js:

  python3 scripts/generar-paginas.py
"""
import html, json, re, shutil
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DOMINIO = 'https://pahlass.com'
AVISO = '<!-- Generado por scripts/generar-paginas.py a partir de index.html. No editar a mano. -->\n'

base = (RAIZ / 'index.html').read_text(encoding='utf-8')
js = (RAIZ / 'assets/js/site.js').read_text(encoding='utf-8')

art = json.loads(re.search(r'^\s*const ART=(\{.*\});\s*$', js, re.M).group(1))
def producto(k):
    m = re.search(r'"%s": \{"n": "[^"]+", "tag": "([^"]+)", "sub": "([^"]+)"' % k, js)
    return m.group(1) + ' ' + m.group(2)

paginas = [
    ('acerca/', 'Acerca de · Pahlass',
     'Por qué existe Pahlass: construimos el modelo operativo detrás de cada decisión, con ingenieros que trabajan de forma permanente junto a cada organización.', 'website'),
    ('prensa/', 'Sala de prensa · Pahlass',
     'Casos, artículos, comunicados e investigación de Pahlass sobre sistemas de dominio de datos en cada industria.', 'website'),
    ('coppermind/', 'Coppermind · Pahlass', producto('coppermind'), 'website'),
    ('diagram/', 'Diagram · Pahlass', producto('diagram'), 'website'),
] + [('casos/%s/' % slug, a['titular'] + ' · Pahlass', a['dek'], 'article') for slug, a in art.items()]

def meta(doc, patron, valor):
    nuevo, n = re.subn(patron, lambda m: m.group(1) + html.escape(valor, quote=True) + m.group(2), doc, count=1)
    assert n == 1, patron
    return nuevo

for ruta in ['acerca', 'prensa', 'coppermind', 'diagram', 'casos']:
    shutil.rmtree(RAIZ / ruta, ignore_errors=True)

for ruta, titulo, desc, tipo in paginas:
    url = DOMINIO + '/' + ruta
    doc = meta(base, r'(<title>)[^<]*(</title>)', titulo)
    doc = meta(doc, r'(<meta name="description" content=")[^"]*(">)', desc)
    doc = meta(doc, r'(<link rel="canonical" href=")[^"]*(">)', url)
    doc = meta(doc, r'(<meta property="og:type" content=")[^"]*(">)', tipo)
    doc = meta(doc, r'(<meta property="og:url" content=")[^"]*(">)', url)
    doc = meta(doc, r'(<meta property="og:title" content=")[^"]*(">)', titulo)
    doc = meta(doc, r'(<meta property="og:description" content=")[^"]*(">)', desc)
    doc = meta(doc, r'(<meta name="twitter:title" content=")[^"]*(">)', titulo)
    doc = meta(doc, r'(<meta name="twitter:description" content=")[^"]*(">)', desc)
    doc = doc.replace('<!doctype html>\n', '<!doctype html>\n' + AVISO, 1)
    destino = RAIZ / ruta / 'index.html'
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(doc, encoding='utf-8')

urls = [('', '1.0')] + [(r, '0.8' if not r.startswith('casos/') else '0.6') for r, *_ in paginas]
(RAIZ / 'sitemap.xml').write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + ''.join('  <url>\n    <loc>%s/%s</loc>\n    <priority>%s</priority>\n  </url>\n' % (DOMINIO, r, p) for r, p in urls)
    + '</urlset>\n', encoding='utf-8')
print('%d páginas generadas y sitemap.xml actualizado' % len(paginas))

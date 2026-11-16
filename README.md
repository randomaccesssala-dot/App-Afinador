# Random Tune

Afinador de guitarra y bajo que escucha por el micrófono. Gratis, sin publicidad y sin cuentas.
Hecho para [Random Access](https://www.instagram.com/randomaccessok/), sala de ensayo en Resistencia, Chaco.

Es una página web que también se instala como app (PWA): se abre desde un link, se puede agregar a la pantalla de inicio y después funciona sin conexión.

## Qué hace

- **Guitarra, bajo y cromático.** Bajo de 4, 5 y 6 cuerdas; guitarra de 6 y 7.
- **Detecta la cuerda sola** (Auto) o se **fija una cuerda** tocándola en pantalla, para salas con ruido o para encordar.
- **Afinaciones incluidas, todas libres:** estándar, Drop D, medio tono abajo, un tono abajo, Drop C, DADGAD, Sol / Re / Mi abierto.
- **Lectura clara a distancia:** nota grande, aguja, cents y Hz. Todo es cromo hasta que la cuerda queda afinada; ahí se enciende el azul.
- **Marca las cuerdas ya afinadas** y avisa con una vibración corta (Android).
- **Nota de referencia** para afinar de oído, y **La ajustable** (415 a 466 Hz).
- **Nombres de notas** en cifrado (E A D G) o latino (Mi La Re Sol).
- **Armónicos:** con una cuerda fijada, el armónico del traste 12 también sirve. Útil para el Si grave del bajo, que los micrófonos de celular captan poco.
- **Compartir:** link y código QR desde la propia app.
- El audio se analiza en el dispositivo. No se graba ni se envía a ningún lado.

## Publicarla (GitHub Pages)

El repositorio es público, así que GitHub la aloja gratis:

1. Llevar estos archivos a la rama `main`.
2. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Elegir la rama `main` y la carpeta `/ (root)`. Guardar.
4. En uno o dos minutos queda en `https://randomaccesssala-dot.github.io/App-Afinador/`.

Ese es el link para compartir. No hay nada que compilar: lo que está en el repositorio es lo que se publica.

> El micrófono solo funciona en páginas seguras (`https://`) o en `localhost`. GitHub Pages ya usa `https`.
>
> Si el link se abre dentro de Instagram u otra app, puede que el micrófono esté bloqueado. En ese caso hay que abrirlo en Chrome o Safari.

### Instalarla como app

- **Android (Chrome):** menú ⋮ → *Instalar app*, o desde Ajustes dentro de Random Tune.
- **iPhone (Safari):** botón Compartir → *Agregar a inicio*.

## Probarla en la computadora

```bash
npm start          # sirve la carpeta en http://localhost:8080
```

## Pruebas

```bash
npm test           # motor de afinación, con cuerdas sintéticas
npm run test:e2e   # la app completa en Chromium, con un audio como micrófono (necesita Playwright)
```

Las pruebas del motor cubren todas las cuerdas de todas las afinaciones a 44,1 y 48 kHz, la fundamental casi ausente (como la capta un celular), ruido de sala, inarmonicidad y errores de octava.

## Cómo está armada

| Archivo | Qué es |
| --- | --- |
| `index.html`, `css/styles.css` | Interfaz |
| `js/pitch.js` | Detección de altura: YIN en dos etapas, con verificación de octava |
| `js/music.js` | Notas, afinaciones y asignación de cuerdas |
| `js/tracker.js` | Estabiliza las lecturas y descarta saltos aislados |
| `js/app.js` | Micrófono, aguja, cuerdas, ajustes y compartir |
| `sw.js`, `manifest.webmanifest` | Instalación y uso sin conexión |
| `vendor/qrcode.js` | Generador de QR |
| `tests/` | Pruebas |

Para agregar una afinación alcanza con sumar una línea en `INSTRUMENTS` dentro de `js/music.js`.

Al cambiar archivos conviene subir el número de `VERSION` en `sw.js`, así los teléfonos que ya la tienen instalada toman la versión nueva.

## Marca

Sigue el manual de marca de Random Access: Negro Ónix de fondo, degradé cromado, Bricolage Grotesque para todo el texto y el destello de cuatro puntas como firma. El Azul Eléctrico es el único acento vivo y se reserva para lo que importa: la cuerda afinada.

- El nombre **Random Tune** está compuesto en Darkline y guardado como trazos (`assets/wordmark.svg`). La tipografía Darkline no se distribuye en este repositorio.
- El isotipo (`assets/isotipo-blanco.png`) sale del kit de marca.

## Créditos

- [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) — SIL Open Font License 1.1 (`assets/fonts/OFL.txt`).
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) de Kazuhiko Arase — licencia MIT.

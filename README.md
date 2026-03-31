# Presupuestador · Software Projects

Herramienta web de simulación y gestión de presupuestos para consultoras y equipos técnicos.

## Tecnología

- **React 18** + **Vite**
- **xlsx** para exportación a Excel
- Sin backend — todo se guarda en `localStorage`

## Desarrollo local

```bash
npm install
npm run dev
```

Abre http://localhost:5173

## Build para producción

```bash
npm run build
```

La carpeta `dist/` contiene la app lista para desplegar. Puedes arrastrarla directamente a [Netlify](https://netlify.com) o cualquier hosting estático.

## Despliegue en GitHub Pages

1. En `vite.config.js`, descomenta y ajusta la línea `base`:
   ```js
   base: '/nombre-de-tu-repo/',
   ```

2. Instala el plugin de despliegue:
   ```bash
   npm install --save-dev gh-pages
   ```

3. Añade en `package.json`:
   ```json
   "scripts": {
     "deploy": "npm run build && gh-pages -d dist"
   }
   ```

4. Ejecuta:
   ```bash
   npm run deploy
   ```

## Estructura

```
src/
  App.jsx     — Toda la lógica y componentes de la app
  App.css     — Estilos (tema claro, colores corporativos #0a2a3b / #12a8e1)
  main.jsx    — Entry point de React
index.html    — HTML base
vite.config.js
```

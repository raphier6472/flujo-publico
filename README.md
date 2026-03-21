<div align="center">

# flujo 💸

**Dashboard financiero personal · Self-hosted · Open source**

[![Dashboard](docs/screenshots/Dashboard mensual.png)
[![Prespuesto?mensual](docs/screenshots/Presupuesto mensual.png)
[![Presupuesto_movil](docs/screenshots/Presupuesto Movil.png)
[![Gestion_Usuarios](docs/screenshots/Gestion de usuarios.png)

App de control financiero personal construida desde cero.
Corre en infraestructura propia, sin servicios de terceros para los datos.

</div>

## ¿Por qué construí esto?

Trabajo en finanzas y ciberseguridad. Ninguna app existente hacía exactamente lo que necesitaba, y tampoco quería que mis datos financieros vivieran en servidores de terceros.

Así que lo construí desde cero — como primer proyecto real de programación, conectando mis conocimientos de finanzas y seguridad con código propio.

---

## Características

- **Dashboard anual** con gráficas de tendencia, tasa de ahorro y distribución por categoría
- **Control mensual** con transacciones, diferidos (compras en cuotas) y rollover de ahorro
- **Presupuestos** por categoría macro con alertas cuando te acercas al límite
- **Multi-usuario** con aislamiento completo de datos por usuario
- **Modo offline** con fallback automático a IndexedDB cuando no hay conexión
- **Sincronización en tiempo real** entre dispositivos via Server-Sent Events
- **Dark mode / Light mode** con canvas theme-aware
- **Responsive** — funciona en iPhone y Android con bottom navigation nativa

---

## Stack tecnológico

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend                                                   │
│  HTML + CSS + JavaScript vanilla (ES modules)               │
│  10 módulos independientes · sin frameworks · sin build     │
├─────────────────────────────────────────────────────────────┤
│  Backend                                                    │
│  Node.js 20 + Express 5 · better-sqlite3 (WAL mode)        │
│  Auth: scrypt nativo · Sesiones SQLite-backed · JWT         │
│  Validación: validators.js puro · Tests: node:test          │
├─────────────────────────────────────────────────────────────┤
│  Infraestructura                                            │
│  Docker Compose · Nginx (Alpine)                            │
│  Cloudflare Tunnel (sin puertos abiertos)                   │
│  Proxmox LXC en homelab propio                              │
├─────────────────────────────────────────────────────────────┤
│  CI/CD                                                      │
│  GitHub Actions: Lint → Tests → Docker Build                │
│  deploy.sh con backup automático y rollback                 │
│  backup.sh con cron diario y retención de 7 días            │
└─────────────────────────────────────────────────────────────┘
```

---

## Arquitectura de seguridad

Uno de los aprendizajes más importantes del proyecto fue construir auth real desde el principio:

```
Login  →  scrypt(password, salt)  →  token 64 hex chars
              ↓
       SQLite sessions (TTL 24h sliding window)
              ↓
       X-Flujo-Token header en cada request
              ↓
       user_id INTEGER en todas las tablas
       (datos completamente aislados por usuario)
```

- Contraseñas con **scrypt** (nativo de Node.js — sin dependencias externas)
- Comparación con **timingSafeEqual** para prevenir timing attacks
- Rate limiting granular: 10 intentos de login / 15 min
- Máximo 5 sesiones simultáneas por usuario
- FK `ON DELETE CASCADE` — borrar usuario elimina todos sus datos atómicamente
- Headers de seguridad Nginx: CSP, HSTS, X-Frame-Options, X-Content-Type-Options

---

## Setup rápido

### Prerequisitos
- Docker Desktop
- Git

### 1. Clonar y configurar

```bash
git clone https://github.com/raphier6472/flujo-publico.git
cd flujo
cp .env.example .env
# Editar .env con tu CLOUDFLARE_TUNNEL_TOKEN y ALLOWED_ORIGINS
```

### 2. Levantar

```bash
docker compose up -d --build
```

### 3. Primer acceso

```bash
# Ver el token de setup en los logs
docker compose logs api | grep -A3 "Token de setup"
```

Abre `http://localhost:8080` → usa el token para crear tu cuenta admin.

---

## Desarrollo local

```bash
# Entorno de desarrollo con hot-reload
docker compose -f docker-compose.dev.yml up -d --build

# La app corre en http://localhost:8080
# Cambios en backend/src/ recargan automáticamente
# Cambios en web/ se ven al refrescar el navegador

# Tests
cd backend && npm test

# Lint
cd backend && npm run lint
```

---

## Deploy

```bash
# En el servidor (LXC)
git pull origin main
./deploy.sh          # rebuild completo
./deploy.sh web      # solo frontend
./deploy.sh api      # solo backend
./deploy.sh rollback # emergencia — vuelve al commit anterior
```

---

## Flujo de trabajo Git

```
main   ← producción (CI obligatorio para merge)
└── dev    ← integración
    └── feature/xxx  ← desarrollo diario
```

Cada push dispara GitHub Actions: **Lint + Tests + Docker Build** (en main).

---

## Estructura del proyecto

```
flujo/
├── .github/workflows/ci.yml    ← CI automático
├── backend/
│   ├── src/
│   │   ├── server.js           ← Express + auth + admin
│   │   ├── routes.js           ← REST API por usuario
│   │   ├── db.js               ← SQLite DAOs + migraciones
│   │   ├── auth.js             ← scrypt + setup token
│   │   ├── sessions.js         ← sesiones persistentes
│   │   ├── validators.js       ← validación pura
│   │   └── sse.js              ← sync tiempo real
│   └── tests/                  ← node:test (22+ casos)
└── web/
    ├── js/                     ← 10 ES modules
    ├── css/                    ← design tokens + responsive
    └── nginx.conf              ← proxy + CSP + HSTS
```

---

## Lo que aprendí construyendo esto

1. **La seguridad se diseña desde el inicio** — migrar de PIN a auth real es mucho más costoso que hacerlo bien desde el principio

2. **SQLite es sorprendentemente capaz** — WAL mode, FK con CASCADE, migraciones automáticas. Para uso personal/familiar no necesitas PostgreSQL

3. **Las capas de caché son invisibles hasta que te rompen** — Docker layer cache + Cloudflare CDN + browser cache. Cada una puede servirte versiones obsoletas

4. **GitHub Actions cambió mi forma de trabajar** — no poder hacer merge con CI rojo es una restricción que te hace mejor desarrollador

5. **Los proyectos propios enseñan lo que los cursos no pueden** — la diferencia entre saber cómo funciona algo y saber cómo construirlo

---

## Roadmap

- [ ] PWA manifest + Service Worker (instalación en iPhone/Android)
- [ ] Búsqueda global de transacciones (Cmd+K)
- [ ] Metas de ahorro con barra de progreso
- [ ] Transacciones recurrentes
- [ ] Exportación de reportes en PDF
- [ ] Tooltips interactivos en charts

---

## Licencia

MIT — úsalo, modifícalo, compártelo.

---

<div align="center">

Construido con ☕ desde finanzas y ciberseguridad · LATAM

**[⭐ Dale una estrella si te fue útil](https://github.com/raphier6472/flujo)**

</div>

# MONITOR USDT — Compra y Auditoría de Activos Digitales (USDT) en Vivo

Plataforma web privada conectada a la API oficial de **Binance C2C (P2P)** para contabilizar, auditar y liquidar ciclos de compra de **USDT** por **Banesco** y **Banco de Venezuela** en tiempo real.

## Características Principales
- **👑 Jerarquía Multi-Nivel**:
  - **Admin Supremo (`ADMIN`)**: Control total, gestión de Comerciantes (`🛡️ Comerciantes`), Clientes propios, API Keys propias y ciclos.
  - **Comerciante (`MERCHANT`)**: Entorno aislado donde cada comerciante configura sus propias API Keys de Binance, registra a sus propios clientes y gestiona sus propios ciclos y reportes sin interferir con el Admin Supremo.
  - **Cliente (`CLIENT`)**: Acceso en tiempo real únicamente a sus propios ciclos en curso y a su historial de ciclos finalizados.
- **🏦 Multi-Banco Simultáneo**: Ciclos independientes en vivo para **Banesco** y **Banco de Venezuela**.
- **📊 Reportes Ejecutivos en Excel**: Descarga de estados de cuenta detallados optimizados para pantalla de laptop.

---

## 🚀 Despliegue en Render

1. Sube este repositorio a tu cuenta de **GitHub** (el archivo `.gitignore` ya protege tu `data.json` local para que **nunca** se suban tus API Keys de Binance al repositorio).
2. Entra a [Render.com](https://render.com) -> **New +** -> **Web Service** y conecta tu repositorio de GitHub.
3. Configura el servicio con estos datos (o usa **Blueprint** con el archivo `render.yaml` incluido):
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. En la sección **Environment Variables** de Render puedes configurar opcionalmente:
   - `ADMIN_PASSWORD`: Tu clave de Admin Supremo (por defecto `09009001009`).
   - `BINANCE_API_KEY`: Tu API Key de Binance (también puedes guardarla desde el botón `⚙️ API Keys` dentro de la web).
   - `BINANCE_SECRET_KEY`: Tu Secret Key de Binance.
   - `DATA_FILE`: Si contratas un **Persistent Disk** en Render para que los ciclos/clientes no se reinicien cuando Render actualice el servidor, pon la ruta `/var/data/data.json`.


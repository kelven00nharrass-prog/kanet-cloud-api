# 🛰️ Ka-Net Cloud API (Render + Firebase)

API central em Node.js de alta performance para execução de transferências USSD e integração em tempo real com dispositivos Android via Firebase.

---

## 🚀 Como Fazer o Deploy no Render

1. Crie uma conta no [Render.com](https://render.com).
2. Conecte o repositório Git ou crie um novo **Web Service**.
3. Configure os seguintes parâmetros no Render:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server.js`
   - **Health Check Path:** `/health`

### 🔑 Variáveis de Ambiente no Render (Environment Variables):
- `NODE_ENV`: `production`
- `MASTER_TOKEN`: `KaNetKelven2026Secure`
- `FIREBASE_DATABASE_URL`: `https://ka-net-math.firebaseio.com`
- `FIREBASE_SERVICE_ACCOUNT`: Conteúdo JSON da chave privada da conta de serviço do Firebase (ou em Base64 em `FIREBASE_SERVICE_ACCOUNT_BASE64`).

---

## 📡 Endpoints da API

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/health` | Status de saúde da API e uptime |
| `POST` | `/api/transferir` | Despacha transferência para a fila Firebase |
| `GET` | `/api/orders/:id` | Consulta o status de um pedido |
| `GET` | `/api/devices` | Lista status de todos os celulares |
| `GET` | `/api/devices/:port/health` | Health check do celular na porta indicada |
| `POST` | `/api/webhooks/paymoz` | Webhook de confirmação automática M-Pesa |

---

## 🔥 Estrutura no Firebase Firestore

- **Coleção `orders`**: Pedidos de transferência pendentes, em execução e concluídos.
- **Coleção `devices`**: Status dos celulares (bateria, sinal, saldo SIM 1 / SIM 2, online/offline).

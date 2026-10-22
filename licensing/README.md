# 🔐 Ka-Net Licensing System

Sistema de licenciamento multi-tenant integrado no Ka-Net Cloud API.

---

## 🚀 Como Usar (Kelven)

### 1. Arrancar o servidor normalmente
```bash
node server.js
# O sistema de licenciamento sobe automaticamente com o servidor!
```

### 2. Aceder ao Painel Admin
```
http://localhost:3000/licensing/admin
```
Token de acesso: **`KaNet-MASTER-KELVEN-2026`**  
*(guardar este token em segurança — está no `.env`)*

---

## 📋 API Endpoints

### Endpoints públicos (sem token)
| Método | URL | Descrição |
|--------|-----|-----------|
| GET | `/licensing/ping` | Testar se a API está online |
| GET | `/licensing/packages` | Ver pacotes disponíveis |

### Endpoints master (token Kelven obrigatório)
| Método | URL | Descrição |
|--------|-----|-----------|
| GET | `/licensing/stats` | Estatísticas gerais |
| GET | `/licensing/licenses` | Listar todas as licenças |
| POST | `/licensing/licenses` | Criar nova licença |
| GET | `/licensing/licenses/:id` | Ver licença |
| POST | `/licensing/licenses/:id/renew` | Renovar licença |
| POST | `/licensing/licenses/:id/suspend` | Suspender |
| POST | `/licensing/licenses/:id/activate` | Activar |
| DELETE | `/licensing/licenses/:id` | Eliminar |

### Endpoints do licenciado (token da licença)
| Método | URL | Descrição |
|--------|-----|-----------|
| GET | `/licensing/me` | Ver dados da sua licença |
| GET | `/licensing/verify` | Verificar validade |
| POST | `/licensing/heartbeat` | Heartbeat do bot |
| GET | `/licensing/me/masters` | Ver números master |
| POST | `/licensing/me/masters` | Adicionar número master |
| DELETE | `/licensing/me/masters/:number` | Remover número master |
| PUT | `/licensing/me/port-mapping` | Configurar portas (pacote FULL) |
| GET | `/licensing/me/sessions` | Ver sessões WhatsApp |

---

## 📦 Pacotes

| Pacote | Preço | WhatsApps | Portas |
|--------|-------|-----------|--------|
| Revendedor Básico | 500 MT/mês | 2 | 1 normal + 8777 |
| Revendedor Pro | 1.200 MT/mês | 5 | 4 normais + 8777 |
| Fornecedor | 1.500 MT/mês | Ilimitado | Todas normais + saldo |
| FULL | 2.000 MT/mês | Ilimitado | Todas + configuração por tipo |

---

## 🔑 Como Criar uma Licença

### Via Painel Admin (recomendado)
1. Abrir `http://localhost:3000/licensing/admin`
2. Clicar em **"➕ Nova Licença"**
3. Preencher nome, telefone, pacote, duração
4. Clicar em **"✅ Criar Licença"**
5. Copiar o **token gerado** e entregar ao licenciado

### Via API (PowerShell)
```powershell
$body = @{
  ownerName    = "Nome do Cliente"
  ownerPhone   = "258840000000"
  packageId    = "revendedor_basico"  # ou revendedor_pro, fornecedor, full
  durationDays = 30
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://localhost:3000/licensing/licenses" `
  -Method POST `
  -Headers @{"Authorization"="Bearer KaNet-MASTER-KELVEN-2026"; "Content-Type"="application/json"} `
  -Body $body
```

---

## ⚙️ Variáveis de Ambiente

```env
MASTER_LICENSE_TOKEN=KaNet-MASTER-KELVEN-2026
```

---

## 📁 Estrutura de Ficheiros

```
licensing/
├── admin/
│   ├── index.html      ← Painel Admin (interface)
│   ├── style.css       ← Estilos dark theme
│   └── app.js          ← Lógica do painel
├── data/
│   └── licenses.json   ← Base de dados (JSON local)
├── kanet-licensing-server.js  ← Servidor standalone (porta 3001)
├── license_checker.js  ← Heartbeat de expiração (corre a cada hora)
├── license_manager.js  ← CRUD de licenças
├── license_middleware.js  ← Auth middleware Express
├── license_routes.js   ← Rotas REST
└── packages.js         ← Definição dos pacotes e preços
```

---

## 🔒 Como Funciona a Expiração

1. O `license_checker.js` verifica todas as licenças **a cada hora**
2. Se uma licença expirou → muda `status` para `expired`
3. O licenciado recebe `403 Forbidden` ao tentar usar a API
4. Os dados são preservados (para renovação futura)
5. Para renovar: `POST /licensing/licenses/:id/renew` com `{ durationDays: 30 }`

---

*Ka-Net Licensing System v1.0 — Desenvolvido por Antigravity para Kelven*

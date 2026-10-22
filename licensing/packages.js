/**
 * Ka-Net Licensing System — Definição de Pacotes
 * ------------------------------------------------
 * FICHEIRO NOVO — não afecta o sistema actual
 */

'use strict';

const PACKAGES = {
  revendedor_basico: {
    id: 'revendedor_basico',
    name: '🔵 Revendedor Básico',
    price: 500,           // MT/mês
    maxWhatsapps: 2,      // máx sessões Baileys
    ports: {
      normalCount: 1,     // 1 porta normal
      port8777: true,     // tem porta 8777
      saldo: false        // sem porta saldo
    },
    portMapping: false,   // sem configuração de mapeamento por tipo
    masterNumbers: true,  // pode definir números master
    description: 'Até 2 WhatsApps, 1 porta normal, 1 porta 8777'
  },

  revendedor_pro: {
    id: 'revendedor_pro',
    name: '🟡 Revendedor Pro',
    price: 1200,
    maxWhatsapps: 5,
    ports: {
      normalCount: 4,
      port8777: true,
      saldo: false
    },
    portMapping: false,
    masterNumbers: true,
    description: 'Até 5 WhatsApps, 4 portas normais, 1 porta 8777'
  },

  fornecedor: {
    id: 'fornecedor',
    name: '🟠 Fornecedor',
    price: 1500,
    maxWhatsapps: -1,     // -1 = ilimitado
    ports: {
      normalCount: -1,    // todas as portas normais
      port8777: false,    // sem porta 8777
      saldo: true         // tem porta saldo
    },
    portMapping: false,
    masterNumbers: true,
    description: 'WhatsApps ilimitados, todas as portas normais, porta saldo'
  },

  full: {
    id: 'full',
    name: '🔴 FULL (Revenda + Fornecimento)',
    price: 2000,
    maxWhatsapps: -1,
    ports: {
      normalCount: -1,
      port8777: true,
      saldo: true
    },
    portMapping: true,    // pode configurar qual porta responde a revenda/fornecimento
    masterNumbers: true,
    description: 'WhatsApps ilimitados, todas as portas, configuração por tipo'
  }
};

/**
 * Permissões disponíveis para números master
 */
const MASTER_PERMISSIONS = [
  { id: 'admin',       label: 'Administrador',      desc: 'Acesso total ao sistema' },
  { id: 'relatorios',  label: 'Relatórios',          desc: 'Ver relatórios de vendas' },
  { id: 'configurar',  label: 'Configurações',        desc: 'Alterar configurações do bot' },
  { id: 'txeneco',     label: 'Txeneco',              desc: 'Gerir créditos e saldos' },
  { id: 'grupos',      label: 'Grupos',               desc: 'Gerir grupos WhatsApp' },
  { id: 'clientes',    label: 'Clientes',             desc: 'Ver e gerir clientes' }
];

/**
 * Tipos de mapeamento de porta (pacote FULL)
 */
const PORT_TYPES = ['revenda', 'fornecimento', 'ambos'];

/**
 * Retorna definição de um pacote pelo ID
 */
function getPackage(packageId) {
  return PACKAGES[packageId] || null;
}

/**
 * Valida se um packageId existe
 */
function isValidPackage(packageId) {
  return Object.keys(PACKAGES).includes(packageId);
}

/**
 * Lista todos os pacotes como array
 */
function listPackages() {
  return Object.values(PACKAGES);
}

module.exports = {
  PACKAGES,
  MASTER_PERMISSIONS,
  PORT_TYPES,
  getPackage,
  isValidPackage,
  listPackages
};

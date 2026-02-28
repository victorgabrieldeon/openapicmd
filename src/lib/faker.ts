// Pure TypeScript fake data generators — no external dependencies

// ── Helpers ──────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

// ── CPF ───────────────────────────────────────────────────────────────────────

function cpfDigits(): number[] {
  const d = Array.from({ length: 9 }, () => rand(0, 9));

  // First check digit
  const s1 = d.reduce((sum, v, i) => sum + v * (10 - i), 0);
  const r1 = s1 % 11;
  d.push(r1 < 2 ? 0 : 11 - r1);

  // Second check digit
  const s2 = d.reduce((sum, v, i) => sum + v * (11 - i), 0);
  const r2 = s2 % 11;
  d.push(r2 < 2 ? 0 : 11 - r2);

  return d;
}

function genCpf(): string {
  const d = cpfDigits();
  return `${d.slice(0, 3).join('')}.${d.slice(3, 6).join('')}.${d.slice(6, 9).join('')}-${d.slice(9).join('')}`;
}

function genCpfRaw(): string {
  return cpfDigits().join('');
}

// ── CNPJ ─────────────────────────────────────────────────────────────────────

function cnpjDigits(): number[] {
  const d = [...Array.from({ length: 8 }, () => rand(0, 9)), 0, 0, 0, 1];

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const s1 = d.reduce((sum, v, i) => sum + v * w1[i]!, 0);
  const r1 = s1 % 11;
  d.push(r1 < 2 ? 0 : 11 - r1);

  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const s2 = d.reduce((sum, v, i) => sum + v * w2[i]!, 0);
  const r2 = s2 % 11;
  d.push(r2 < 2 ? 0 : 11 - r2);

  return d;
}

function genCnpj(): string {
  const d = cnpjDigits();
  return `${d.slice(0, 2).join('')}.${d.slice(2, 5).join('')}.${d.slice(5, 8).join('')}/${d.slice(8, 12).join('')}-${d.slice(12).join('')}`;
}

function genCnpjRaw(): string {
  return cnpjDigits().join('');
}

// ── Names ────────────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Ana', 'Maria', 'Juliana', 'Fernanda', 'Camila', 'Beatriz', 'Amanda', 'Larissa',
  'Letícia', 'Gabriela', 'Mariana', 'Patrícia', 'Renata', 'Vanessa', 'Bruna',
  'Carlos', 'João', 'Pedro', 'Lucas', 'Marcos', 'Rafael', 'Felipe', 'Bruno',
  'Rodrigo', 'Eduardo', 'Thiago', 'Gustavo', 'André', 'Matheus', 'Leonardo',
] as const;

const LAST_NAMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Ferreira',
  'Rodrigues', 'Almeida', 'Nascimento', 'Carvalho', 'Fernandes', 'Gomes', 'Martins',
  'Araújo', 'Ribeiro', 'Melo', 'Barbosa', 'Rocha', 'Cardoso', 'Correia', 'Dias',
  'Nunes', 'Pinto', 'Moraes', 'Castro', 'Monteiro', 'Teixeira', 'Vieira',
] as const;

const EMAIL_DOMAINS = ['gmail.com', 'hotmail.com', 'yahoo.com.br', 'outlook.com', 'uol.com.br'] as const;

function genNome(): string {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

function genPrimeiroNome(): string {
  return pick(FIRST_NAMES);
}

function genSobrenome(): string {
  return pick(LAST_NAMES);
}

function genEmail(): string {
  const first = pick(FIRST_NAMES).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const last = pick(LAST_NAMES).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const num = rand(1, 999);
  const domain = pick(EMAIL_DOMAINS);
  return `${first}.${last}${num}@${domain}`;
}

// ── Phone ────────────────────────────────────────────────────────────────────

const DDD = ['11', '21', '31', '41', '51', '61', '71', '81', '85', '91'] as const;

function genTelefone(): string {
  const ddd = pick(DDD);
  const n1 = pad(rand(2000, 9999), 4);
  const n2 = pad(rand(1000, 9999), 4);
  return `(${ddd}) ${n1}-${n2}`;
}

function genCelular(): string {
  const ddd = pick(DDD);
  const n1 = pad(rand(10000, 99999), 5);
  const n2 = pad(rand(1000, 9999), 4);
  return `(${ddd}) 9${n1}-${n2}`;
}

// ── Address ───────────────────────────────────────────────────────────────────

function genCep(): string {
  const p1 = pad(rand(1000, 99999), 5);
  const p2 = pad(rand(0, 999), 3);
  return `${p1}-${p2}`;
}

// ── General ───────────────────────────────────────────────────────────────────

function genUuid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join('');
  return `${s(8)}-${s(4)}-4${s(3)}-${['8', '9', 'a', 'b'][rand(0, 3)]}${s(3)}-${s(12)}`;
}

function genData(): string {
  const year = rand(2020, 2025);
  const month = rand(1, 12);
  const day = rand(1, 28);
  return `${year}-${pad(month)}-${pad(day)}`;
}

function genDatetime(): string {
  const year = rand(2020, 2025);
  const month = rand(1, 12);
  const day = rand(1, 28);
  const hour = rand(0, 23);
  const min = rand(0, 59);
  const sec = rand(0, 59);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:${pad(sec)}`;
}

function genInteiro(): string {
  return String(rand(1, 9999));
}

function genDecimal(): string {
  return (rand(1, 9999) + Math.random()).toFixed(2);
}

// ── Catalogue ────────────────────────────────────────────────────────────────

export interface FakerEntry {
  id: string;
  label: string;
  category: string;
  generate: () => string;
}

export const FAKER_ENTRIES: FakerEntry[] = [
  // Pessoa
  { id: 'cpf',           category: 'Pessoa',   label: 'CPF formatado',      generate: genCpf },
  { id: 'cpf_raw',       category: 'Pessoa',   label: 'CPF sem formatação', generate: genCpfRaw },
  { id: 'nome',          category: 'Pessoa',   label: 'Nome completo',      generate: genNome },
  { id: 'primeiro_nome', category: 'Pessoa',   label: 'Primeiro nome',      generate: genPrimeiroNome },
  { id: 'sobrenome',     category: 'Pessoa',   label: 'Sobrenome',          generate: genSobrenome },
  { id: 'email',         category: 'Pessoa',   label: 'E-mail',             generate: genEmail },
  { id: 'telefone',      category: 'Pessoa',   label: 'Telefone fixo',      generate: genTelefone },
  { id: 'celular',       category: 'Pessoa',   label: 'Celular',            generate: genCelular },
  // Empresa
  { id: 'cnpj',          category: 'Empresa',  label: 'CNPJ formatado',     generate: genCnpj },
  { id: 'cnpj_raw',      category: 'Empresa',  label: 'CNPJ sem formatação',generate: genCnpjRaw },
  // Endereço
  { id: 'cep',           category: 'Endereço', label: 'CEP',                generate: genCep },
  // Geral
  { id: 'uuid',          category: 'Geral',    label: 'UUID',               generate: genUuid },
  { id: 'data',          category: 'Geral',    label: 'Data (YYYY-MM-DD)',  generate: genData },
  { id: 'datetime',      category: 'Geral',    label: 'Data/hora ISO',      generate: genDatetime },
  { id: 'inteiro',       category: 'Geral',    label: 'Número inteiro',     generate: genInteiro },
  { id: 'decimal',       category: 'Geral',    label: 'Número decimal',     generate: genDecimal },
];

/** Auto-suggest a faker value for a form field based on name + schema hints.
 *  Returns null when no heuristic matches. */
export function suggestFakerForField(
  fieldName: string,
  type: string,
  format?: string,
  enumValues?: string[]
): string | null {
  if (enumValues?.length) return enumValues[0]!;

  const n = fieldName.toLowerCase();

  // Format-based (authoritative)
  if (format === 'date-time') return genDatetime();
  if (format === 'date')      return genData();
  if (format === 'email')     return genEmail();
  if (format === 'uuid')      return genUuid();

  // Brazilian documents
  if (n.includes('cpf'))  return (n.includes('raw') || n.includes('sem')) ? genCpfRaw()  : genCpf();
  if (n.includes('cnpj')) return (n.includes('raw') || n.includes('sem')) ? genCnpjRaw() : genCnpj();
  if (n.includes('cep') || n === 'zip' || n.includes('postal')) return genCep();

  // Contact
  if (n.includes('email') || n.includes('e-mail')) return genEmail();
  if (n.includes('celular') || n.includes('mobile') || n.includes('whatsapp')) return genCelular();
  if (n.includes('telefone') || n.includes('phone') || n.includes('fone'))     return genTelefone();

  // Names
  if (n === 'nome' || n === 'name' || n === 'fullname' || n === 'full_name' || n.endsWith('_nome') || n.endsWith('_name')) return genNome();
  if (n.includes('primeiro') || n === 'first_name' || n === 'firstname') return genPrimeiroNome();
  if (n.includes('sobrenome') || n === 'last_name'  || n === 'lastname')  return genSobrenome();

  // Dates
  if (n.endsWith('_at') || n.endsWith('date') || n.endsWith('_data') || n === 'data' || n === 'date') {
    return (type.includes('time') || n.includes('hora') || n.includes('time')) ? genDatetime() : genData();
  }

  // UUIDs / generic IDs
  if (n === 'id' || n === 'uuid' || n.endsWith('_id') || n.endsWith('_uuid')) return genUuid();

  // Type-based fallback
  const base = type.replace('?', '').replace('[]', '');
  if (base === 'integer') return genInteiro();
  if (base === 'number')  return genDecimal();
  if (base === 'boolean') return 'true';

  return null;
}
